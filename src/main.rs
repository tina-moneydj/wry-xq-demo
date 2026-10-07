// XQ 風格的測試程式：Rust (tao) 開視窗，裡面放兩個 webview。
// - 主 webview：鋪滿整個視窗，用 HTML/CSS/JS 畫出走勢圖、報價、分割線。
// - 子 webview：疊在右下格上面，載入真正的網站（不受 X-Frame-Options 限制）。
// 網頁 JS 會把右下格的位置用 window.ipc.postMessage 傳回來，Rust 再呼叫 set_bounds。
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::time::Duration;

mod engine;

use serde::Deserialize;
use serde_json::Value;
use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Window, WindowBuilder},
};
use wry::{PageLoadEvent, Rect, WebViewBuilder};

const HOME_URL: &str = "https://www.twse.com.tw/zh/";
const UI_HTML: &str = include_str!("../ui/index.html");
// with_html 不能載入相對路徑的檔案，所以把走勢圖程式直接塞進 HTML 裡。
const CHART_JS: &str = include_str!("../ui/chart.js");
const WATCHLIST_JS: &str = include_str!("../ui/watchlist.js");

/// 主 webview 送來的訊息（JSON）。
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum IpcMessage {
    /// 右下格的位置與大小，單位是實體像素（JS 已乘上 devicePixelRatio）。
    Bounds { x: f64, y: f64, w: f64, h: f64 },
    /// 點了某一檔報價。
    Quote { symbol: String },
    /// 回到首頁。
    Home,
    /// 在右下子 webview 開啟指定網址（分頁切換、新分頁用）。
    Open { url: String },
    /// 除錯訊息（XQ_DEBUG=1 時 JS 才會送），印到 stderr。
    Log { msg: String },
    /// 畫線與指標設定，整份存成 JSON 檔（下次啟動時再交回給網頁）。
    Save { data: serde_json::Value },
    /// 要向 XQNext 訂閱的代號。chart 是目前走勢圖，period 為 T 時才要分時。
    Feed { symbols: Vec<String>, chart: String, period: String },
}

/// 從 webview 回呼送到主執行緒事件迴圈的事件。
#[derive(Debug)]
enum UserEvent {
    Ipc(IpcMessage),
    Navigate(String),
    ChildLoaded(String),
    /// 約每秒一次的程序記憶體取樣（含 WebView 子行程），給狀態列用。
    MemStats { rss_mb: f64, rss_max_mb: f64, cpu_pct: f64 },
    /// XQNext 合併後的一包行情，交給網頁一次畫完。
    EnginePush(Value),
}


/// 合併同一幀內多包 Engine 推送：報價／分鐘線各代號只留最新，分時整包覆蓋，減少 evaluate_script。
fn coalesce_engine_push(dst: &mut Option<Value>, src: Value) {
    let Some(obj) = src.as_object() else {
        *dst = Some(src);
        return;
    };
    let entry = dst.get_or_insert_with(|| serde_json::json!({}));
    let map = entry.as_object_mut().unwrap();
    if let Some(quotes) = obj.get("quotes").and_then(|v| v.as_array()) {
        let slot = map
            .entry("quotes".to_string())
            .or_insert_with(|| serde_json::json!([]));
        let arr = slot.as_array_mut().unwrap();
        for q in quotes {
            let sym = q.get("symbol").and_then(|s| s.as_str()).unwrap_or("");
            if let Some(pos) = arr
                .iter()
                .position(|x| x.get("symbol").and_then(|s| s.as_str()) == Some(sym))
            {
                arr[pos] = q.clone();
            } else {
                arr.push(q.clone());
            }
        }
    }
    if let Some(intra) = obj.get("intraday") {
        map.insert("intraday".to_string(), intra.clone());
    }
    if let Some(mins) = obj.get("minutes").and_then(|v| v.as_array()) {
        let slot = map
            .entry("minutes".to_string())
            .or_insert_with(|| serde_json::json!([]));
        let arr = slot.as_array_mut().unwrap();
        for m in mins {
            let sym = m.get("symbol").and_then(|s| s.as_str()).unwrap_or("");
            if let Some(pos) = arr
                .iter()
                .position(|x| x.get("symbol").and_then(|s| s.as_str()) == Some(sym))
            {
                arr[pos] = m.clone();
            } else {
                arr.push(m.clone());
            }
        }
    }
}

fn main() -> wry::Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let (feed_tx, feed_rx) = std::sync::mpsc::channel::<engine::FeedCmd>();
    engine::spawn(proxy.clone(), feed_rx, UserEvent::EnginePush);

    // 設定檔寫入專用背景執行緒：事件迴圈只 enqueue，避免同步磁碟 I/O 卡 UI。
    let (save_tx, save_rx) = std::sync::mpsc::channel::<(PathBuf, Value)>();
    std::thread::spawn(move || {
        while let Ok((path, data)) = save_rx.recv() {
            // 排空只留最後一筆，連點／高頻 save 不堆疊寫檔
            let mut path = path;
            let mut data = data;
            while let Ok((p2, d2)) = save_rx.try_recv() {
                path = p2;
                data = d2;
            }
            if let Err(error) = save_state(&path, &data) {
                eprintln!("無法儲存設定到 {}: {error}", path.display());
            }
        }
    });

    let window = WindowBuilder::new()
        .with_title("XQ 風格測試 (tao + wry)")
        .with_inner_size(LogicalSize::new(1100.0, 720.0))
        .with_min_inner_size(LogicalSize::new(640.0, 420.0))
        .build(&event_loop)
        .expect("無法建立視窗");

    // Windows / macOS / Linux(X11) 都用 build_as_child，兩個 webview 都是視窗的子元件，
    // 位置與大小全部由我們用 set_bounds 控制。Linux 只支援 X11（Wayland 不行）。
    let build = |builder: WebViewBuilder<'_>| builder.build_as_child(&window);

    // XQ_DEBUG=1 時，網頁會把拖拉等事件用 ipc 送回來印在終端機。
    let debug = std::env::var_os("XQ_DEBUG").is_some_and(|v| v != "0");

    // 上次存的畫線與指標設定：用初始化腳本放進 window.XQ_STATE（比 localStorage 可靠，
    // with_html 的頁面在 WebView2 是 about:blank，localStorage 不一定能用或會保存）。
    let state_file = state_path();
    let saved_state = state_file
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(|value| value.is_object())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".into());
    let tab_stress = std::env::var_os("XQ_TAB_STRESS").is_some_and(|v| v != "0");
    let group_stress = std::env::var_os("XQ_GROUP_STRESS").is_some_and(|v| v != "0");
    let wheel_perf = std::env::var_os("XQ_WHEEL_PERF").is_some_and(|v| v != "0"); // render() 單幀成本壓測（wheel 縮放熱路徑）
    let init_script = format!(
        "window.XQ_STATE = {saved_state};{}{}{}{}",
        if debug { " window.XQ_DEBUG = true;" } else { "" },
        if tab_stress { " window.XQ_TAB_STRESS = true;" } else { "" },
        if group_stress { " window.XQ_GROUP_STRESS = true;" } else { "" },
        if wheel_perf { " window.XQ_WHEEL_PERF = true;" } else { "" }
    );

    // 1) 主 webview（先建立，在下層）。
    let ipc_proxy = proxy.clone();
    let main_builder = WebViewBuilder::new()
            .with_bounds(full_window_rect(&window))
            .with_initialization_script(&init_script)
            .with_html(
                UI_HTML
                    .replace("/*__CHART_JS__*/", CHART_JS)
                    .replace("/*__WATCHLIST_JS__*/", WATCHLIST_JS),
            )
            .with_ipc_handler(move |request| {
                match serde_json::from_str::<IpcMessage>(request.body()) {
                    Ok(message) => {
                        let _ = ipc_proxy.send_event(UserEvent::Ipc(message));
                    }
                    Err(error) => eprintln!("看不懂的 ipc 訊息 {:?}: {error}", request.body()),
                }
            });
    // Linux：主 webview 直接放進 tao 視窗的 GTK vbox（會自動鋪滿）。
    // 如果也用 X11 子視窗，WebKitGTK 在每次點擊放開後就收不到滑鼠移動（hover、十字線失效），
    // 要等游標離開視窗再回來才恢復。右下的網頁仍用 X11 子視窗，才能疊在上面並用 set_bounds 移動。
    #[cfg(target_os = "linux")]
    let main_view = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        main_builder.build_gtk(window.default_vbox().expect("tao default vbox"))?
    };
    #[cfg(not(target_os = "linux"))]
    let main_view = build(main_builder)?;

    // 2) 子 webview（後建立，疊在主 webview 上面）。先給 1x1，等 JS 回報右下格位置再搬過去。
    let load_proxy = proxy.clone();
    let popup_proxy = proxy.clone();
    let web_view = build(
        WebViewBuilder::new()
            .with_bounds(Rect {
                position: PhysicalPosition::new(0, 0).into(),
                size: PhysicalSize::new(1u32, 1u32).into(),
            })
            .with_url(HOME_URL)
            .with_on_page_load_handler(move |event, url| {
                if let PageLoadEvent::Finished = event {
                    let _ = load_proxy.send_event(UserEvent::ChildLoaded(url));
                }
            })
            // 網站用 target=_blank 開新視窗時，改成在同一格裡開。
            .with_new_window_req_handler(move |url, _features| {
                let _ = popup_proxy.send_event(UserEvent::Navigate(url));
                wry::NewWindowResponse::Deny
            }),
    )?;

    // 記憶體狀態列：背景執行緒每 1 秒取樣 RSS（含 WebKit 子行程），不走行情 tick 路徑。
    let mem_proxy = proxy.clone();
    let self_pid = std::process::id();
    std::thread::spawn(move || {
        let mut rss_max = 0.0_f64;
        let mut last_cpu = read_proc_times(self_pid);
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let rss = rss_mb_tree(self_pid);
            if rss > rss_max {
                rss_max = rss;
            }
            let now = read_proc_times(self_pid);
            let cpu = cpu_pct(last_cpu, now);
            last_cpu = now;
            let _ = mem_proxy.send_event(UserEvent::MemStats {
                rss_mb: rss,
                rss_max_mb: rss_max,
                cpu_pct: cpu,
            });
        }
    });

    let mut engine_coalesced: Option<Value> = None;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            // 視窗大小改變：主 webview 跟著鋪滿。右下格的新位置由 JS 的 resize 事件回報。
            Event::WindowEvent { event: WindowEvent::Resized(_), .. } => {
                let _ = main_view.set_bounds(full_window_rect(&window));
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Bounds { x, y, w, h })) => {
                let _ = web_view.set_bounds(Rect {
                    position: PhysicalPosition::new(x.round() as i32, y.round() as i32).into(),
                    size: PhysicalSize::new(w.max(1.0).round() as u32, h.max(1.0).round() as u32).into(),
                });
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Quote { symbol })) => {
                if let Some(url) = quote_url(&symbol) {
                    let _ = web_view.load_url(&url);
                }
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Log { msg })) => {
                eprintln!("[ui] {msg}");
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Save { data })) => {
                if let Some(path) = state_file.clone() {
                    let _ = save_tx.send((path, data));
                }
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Feed { symbols, chart, period })) => {
                let _ = feed_tx.send(engine::FeedCmd { symbols, chart, period });
            }
            Event::UserEvent(UserEvent::EnginePush(value)) => {
                // hello/down：立刻送；行情：合併到 MainEventsCleared 再一次 evaluate
                if value.get("down").is_some() {
                    engine_coalesced = None; // 斷線後丟棄未刷行情，避免殘包晚到
                    let _ = main_view.evaluate_script(&format!(
                        "window.__enginePush&&window.__enginePush({value})"
                    ));
                } else if value.get("hello").is_some() {
                    let _ = main_view.evaluate_script(&format!(
                        "window.__enginePush&&window.__enginePush({value})"
                    ));
                } else {
                    coalesce_engine_push(&mut engine_coalesced, value);
                }
            }
            Event::MainEventsCleared => {
                if let Some(value) = engine_coalesced.take() {
                    let _ = main_view.evaluate_script(&format!(
                        "window.__enginePush&&window.__enginePush({value})"
                    ));
                }
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Home)) => {
                let _ = web_view.load_url(HOME_URL);
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Open { url })) => {
                if url.starts_with("https://") || url.starts_with("http://") {
                    let _ = web_view.load_url(&url);
                }
            }
            Event::UserEvent(UserEvent::Navigate(url)) => {
                if url.starts_with("https://") || url.starts_with("http://") {
                    let _ = web_view.load_url(&url);
                }
            }
            Event::UserEvent(UserEvent::ChildLoaded(url)) => {
                let json = serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".into());
                let _ = main_view.evaluate_script(&format!("window.setWebUrl && window.setWebUrl({json});"));
            }
            Event::UserEvent(UserEvent::MemStats { rss_mb, rss_max_mb, cpu_pct }) => {
                let script = format!(
                    "(function(){{var js=null;try{{if(performance&&performance.memory&&performance.memory.usedJSHeapSize)js=performance.memory.usedJSHeapSize/(1024*1024);}}catch(e){{}}if(window.setMemStats)window.setMemStats({{rssMb:{rss:.1},rssMaxMb:{mx:.1},cpuPct:{cpu:.1},jsHeapMb:js}});}})();",
                    rss = rss_mb, mx = rss_max_mb, cpu = cpu_pct,
                );
                let _ = main_view.evaluate_script(&script);
            }
            _ => {}
        }
    });
}

/// 整個視窗內容區（實體像素）。
fn full_window_rect(window: &Window) -> Rect {
    let size = window.inner_size();
    Rect {
        position: PhysicalPosition::new(0, 0).into(),
        size: PhysicalSize::new(size.width.max(1), size.height.max(1)).into(),
    }
}

/// 股票代號轉成 Yahoo 奇摩股市網址；只接受 4~6 位英數字的代號。
fn quote_url(symbol: &str) -> Option<String> {
    let ok = (4..=6).contains(&symbol.len()) && symbol.chars().all(|c| c.is_ascii_alphanumeric());
    ok.then(|| format!("https://tw.stock.yahoo.com/quote/{symbol}.TW"))
}

/// 設定檔位置：Windows %APPDATA%\wry-xq-demo\state.json，
/// macOS ~/Library/Application Support/wry-xq-demo/state.json，
/// Linux $XDG_DATA_HOME（或 ~/.local/share）/wry-xq-demo/state.json。
fn state_path() -> Option<PathBuf> {
    let env = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    #[cfg(windows)]
    let base = env("APPDATA");
    #[cfg(target_os = "macos")]
    let base = env("HOME").map(|home| home.join("Library").join("Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = env("XDG_DATA_HOME").or_else(|| env("HOME").map(|home| home.join(".local").join("share")));
    base.map(|dir| dir.join("wry-xq-demo").join("state.json"))
}

/// 先寫到暫存檔再改名，避免寫到一半當掉時把舊設定弄壞。
fn save_state(path: &std::path::Path, data: &serde_json::Value) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
    std::fs::rename(&tmp, path)
}


/// 主行程 + 子孫 + WebKit/WebView2 相關子行程的 VmRSS 加總（MB）。
fn rss_mb_tree(pid: u32) -> f64 {
    let mut total_kb = 0u64;
    let mut stack = vec![pid];
    let mut seen = std::collections::HashSet::new();
    while let Some(p) = stack.pop() {
        if !seen.insert(p) { continue; }
        if let Ok(status) = std::fs::read_to_string(format!("/proc/{p}/status")) {
            if let Some(line) = status.lines().find(|l| l.starts_with("VmRSS:")) {
                if let Some(kb) = line.split_whitespace().nth(1) {
                    total_kb += kb.parse::<u64>().unwrap_or(0);
                }
            }
        }
        if let Ok(children) = std::fs::read_to_string(format!("/proc/{p}/task/{p}/children")) {
            for c in children.split_whitespace() {
                if let Ok(cp) = c.parse::<u32>() { stack.push(cp); }
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir("/proc") {
        for ent in rd.flatten() {
            let Ok(p) = ent.file_name().to_string_lossy().parse::<u32>() else { continue };
            if seen.contains(&p) { continue; }
            let cmdline = std::fs::read(format!("/proc/{p}/cmdline")).unwrap_or_default();
            let cmd = String::from_utf8_lossy(&cmdline);
            if !(cmd.contains("WebKitWebProcess") || cmd.contains("WebKitNetworkProcess")
                || cmd.contains("WebKit.WebProcess") || cmd.contains("WebKit.NetworkProcess")
                || cmd.contains("msedgewebview2") || cmd.contains("EmbeddedBrowserWebView")) {
                continue;
            }
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{p}/stat")) else { continue };
            let Some(rest) = stat.rsplit(')').next() else { continue };
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() < 2 { continue; }
            let Ok(ppid) = parts[1].parse::<u32>() else { continue };
            if ppid == pid || seen.contains(&ppid) {
                if let Ok(status) = std::fs::read_to_string(format!("/proc/{p}/status")) {
                    if let Some(line) = status.lines().find(|l| l.starts_with("VmRSS:")) {
                        if let Some(kb) = line.split_whitespace().nth(1) {
                            total_kb += kb.parse::<u64>().unwrap_or(0);
                        }
                    }
                }
            }
        }
    }
    total_kb as f64 / 1024.0
}

fn read_proc_times(pid: u32) -> (u64, u64) {
    let mut proc_t = 0u64;
    if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        if let Some(rest) = stat.rsplit(')').next() {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() > 14 {
                proc_t = parts[12].parse().unwrap_or(0) + parts[13].parse().unwrap_or(0);
            }
        }
    }
    let mut total = 0u64;
    if let Ok(stat) = std::fs::read_to_string("/proc/stat") {
        if let Some(line) = stat.lines().next() {
            for n in line.split_whitespace().skip(1) {
                total += n.parse::<u64>().unwrap_or(0);
            }
        }
    }
    (proc_t, total)
}

fn cpu_pct(prev: (u64, u64), now: (u64, u64)) -> f64 {
    let dp = now.0.saturating_sub(prev.0) as f64;
    let dt = now.1.saturating_sub(prev.1) as f64;
    if dt <= 0.0 { return 0.0; }
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
    (dp / dt) * cpus * 100.0
}
