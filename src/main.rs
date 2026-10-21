// XQ 風格的測試程式：Rust (tao) 開視窗，主 UI + 可選的右下子 webview。
// - 主 webview：鋪滿整個視窗，用 HTML/CSS/JS 畫出走勢圖、報價、分割線。
// - 子 webview：僅在開啟真實 http(s) 時建立，疊在右下格載入網站。
//   about:blank／首頁＝銷毀子 webview，回收 WebKitWebProcess（約 250–300 MB）。
//   真實網頁分頁之間仍可延遲卸載保暖；空白才銷毀是省記憶體的關鍵。
// 網頁 JS 會把右下格的位置用 window.ipc.postMessage 傳回來，Rust 再呼叫 set_bounds。
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::time::{Duration, Instant};

mod engine;
mod push;

use serde::Deserialize;
use serde_json::Value;
use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Window, WindowBuilder},
};
use wry::{PageLoadEvent, Rect, WebView, WebViewBuilder};

const HOME_URL: &str = "about:blank";
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
    /// 在右下子 webview 開啟指定網址（分頁切換、延遲卸載後載入）；`about:blank` 表示卸載。
    Open { url: String },
    /// 除錯訊息（XQ_DEBUG=1 時 JS 才會送），印到 stderr。
    Log { msg: String },
    /// 畫線與指標設定，整份存成 JSON 檔（下次啟動時再交回給網頁）。
    Save { data: serde_json::Value },
    /// 要向 XQNext 訂閱的代號。chart 是目前走勢圖，period 為 T 時才要分時。
    Feed { symbols: Vec<String>, chart: String, period: String },
    /// 網頁已套用上一批行情（在下一個 rAF 送）；resync = 網頁的代號 id 表不完整，要重送定義。
    Ready {
        #[serde(default)]
        resync: bool,
    },
}

/// 從 webview 回呼送到主執行緒事件迴圈的事件。
#[derive(Debug)]
enum UserEvent {
    Ipc(IpcMessage),
    /// XQ_WINDOWS 的其他視窗（編號 k ≥ 1）送來的訊息：只處理 ready／log，其餘（存檔、訂閱、子網頁）以主視窗為準
    PeerIpc(usize, IpcMessage),
    Navigate(String),
    ChildLoaded(String),
    /// 約每秒一次的程序記憶體取樣（含 WebView 子行程），給狀態列用。
    MemStats { rss_mb: f64, rss_max_mb: f64, cpu_pct: f64 },
    /// XQNext 的一包行情（背景執行緒已解碼成型別，主執行緒合併後節流推給網頁）。
    EnginePush(engine::Feed),
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
    // XQ_BENCH=1：第一個 frame／第一筆報價畫出後，網頁送 `BENCH ...` log（bench 腳本打時間戳）
    let bench = std::env::var_os("XQ_BENCH").is_some_and(|v| v != "0");
    // 壓測參數：XQ_STRESS_COLS=6 XQ_STRESS_TICK_MS=30000 XQ_STRESS_SCROLL_MS=10000 XQ_STRESS_TICK_HZ=3000
    let env_num = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let stress_opts = format!(
        " window.XQ_STRESS_OPTS = {{cols:{},tickMs:{},scrollMs:{},tickHz:{}}};",
        env_num("XQ_STRESS_COLS"),
        env_num("XQ_STRESS_TICK_MS"),
        env_num("XQ_STRESS_SCROLL_MS"),
        env_num("XQ_STRESS_TICK_HZ")
    );
    // XQ_CHART_STRESS=1：重圖表壓測（20 疊加＋全部副圖＋1000 畫線，跳價／十字線／平移）。
    // 參數 XQ_CHART_TOP_RATIO（上方走勢圖佔比）XQ_CHART_DRAWINGS XQ_CHART_WARM_MS XQ_CHART_PHASE_MS XQ_CHART_WAIT_MS
    let chart_stress = std::env::var_os("XQ_CHART_STRESS").is_some_and(|v| v != "0");
    let chart_opts = if chart_stress {
        let f = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        format!(
            " window.XQ_CHART_STRESS = true; window.XQ_PERF = true; window.XQ_CHART_OPTS = {{topRatio:{},drawings:{},warmMs:{},phaseMs:{},waitMs:{}}};",
            f("XQ_CHART_TOP_RATIO"),
            std::env::var("XQ_CHART_DRAWINGS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(1000),
            f("XQ_CHART_WARM_MS"),
            f("XQ_CHART_PHASE_MS"),
            f("XQ_CHART_WAIT_MS")
        )
    } else {
        String::new()
    };
    let init_tail = format!(
        "{}{}{}{}{}{}{}",
        chart_opts,
        stress_opts,
        if bench { " window.XQ_BENCH = true;" } else { "" },
        if debug { " window.XQ_DEBUG = true;" } else { "" },
        if tab_stress { " window.XQ_TAB_STRESS = true;" } else { "" },
        if group_stress { " window.XQ_GROUP_STRESS = true;" } else { "" },
        if wheel_perf { " window.XQ_WHEEL_PERF = true;" } else { "" }
    ) + if engine::tick_bench_enabled() { " window.XQ_TICK_BENCH = true;" } else { "" };
    let init_script = format!("window.XQ_STATE = {saved_state};{init_tail}");
    let ui_html = UI_HTML.replace("/*__CHART_JS__*/", CHART_JS).replace("/*__WATCHLIST_JS__*/", WATCHLIST_JS);

    // 1) 主 webview（先建立，在下層）。
    let ipc_proxy = proxy.clone();
    let main_builder = WebViewBuilder::new()
            .with_bounds(full_window_rect(&window))
            .with_initialization_script(&init_script)
            .with_html(ui_html.clone())
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

    // 1b) XQ_WINDOWS=N：再開 N-1 個看盤視窗（各一個主 webview，走勢圖＝自選第 k 檔）。
    //     行情連線與解碼只有一份（engine 執行緒），每個視窗各自一個 PushBatch（同一包報價借用合併）、
    //     各自 in-flight 1 批。WebView 架構使然：每個視窗的 JS 各存一份報價表資料（無法跨 webview 共用）。
    let n_windows = std::env::var("XQ_WINDOWS").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).clamp(1, 8);
    let mut peers: Vec<PeerView> = Vec::new();
    for k in 1..n_windows {
        let w = WindowBuilder::new()
            .with_title(format!("XQ 風格測試 (tao + wry) #{}", k + 1))
            .with_inner_size(LogicalSize::new(1100.0, 720.0))
            .with_min_inner_size(LogicalSize::new(640.0, 420.0))
            .build(&event_loop)
            .expect("無法建立視窗");
        let script = format!("window.XQ_STATE = {};{init_tail} window.XQ_WINDOW = {k};", peer_state(&saved_state, k));
        let p = proxy.clone();
        let builder = WebViewBuilder::new()
            .with_bounds(full_window_rect(&w))
            .with_initialization_script(&script)
            .with_html(ui_html.clone())
            .with_ipc_handler(move |request| match serde_json::from_str::<IpcMessage>(request.body()) {
                Ok(message) => {
                    let _ = p.send_event(UserEvent::PeerIpc(k, message));
                }
                Err(error) => eprintln!("看不懂的 ipc 訊息 {:?}: {error}", request.body()),
            });
        #[cfg(target_os = "linux")]
        let view = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            builder.build_gtk(w.default_vbox().expect("tao default vbox"))?
        };
        #[cfg(not(target_os = "linux"))]
        let view = builder.build_as_child(&w)?;
        peers.push(PeerView { window: w, view, batch: push::PushBatch::default(), inflight: None });
    }

    // 2) 子 webview：懶建立。空白右下不建第二個 WebKit，省約 250–300 MB RSS。
    //    開啟 http(s) 時再建；about:blank／Home 時 drop 銷毀。
    let mut web_view: Option<WebView> = None;
    let mut child_bounds = Rect {
        position: PhysicalPosition::new(0, 0).into(),
        size: PhysicalSize::new(1u32, 1u32).into(),
    };
    // `build` 僅非 Linux 主 webview 用；子 webview 一律 build_as_child（Linux 亦然）。
    let _ = build;

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

    // 行情推送：合併＋in-flight 1 批（網頁 rAF 回 ready 才送下一批），見 push.rs
    let mut engine_batch = push::PushBatch::default();
    let mut engine_inflight: Option<Instant> = None;
    const ENGINE_ACK_TIMEOUT: Duration = Duration::from_millis(250);
    let tick_bench = engine::tick_bench_enabled();

    event_loop.run(move |event, _, control_flow| {
        // 有一批在網頁裡、又有新資料等著：最多等 ENGINE_ACK_TIMEOUT 就照送（防頁面沒回 ready 卡住）
        *control_flow = match engine_inflight {
            Some(t) if engine_batch.has_data() => ControlFlow::WaitUntil(t + ENGINE_ACK_TIMEOUT),
            _ => ControlFlow::Wait,
        };
        for p in &peers {
            if let (Some(t), true) = (p.inflight, p.batch.has_data()) {
                let until = t + ENGINE_ACK_TIMEOUT;
                *control_flow = match *control_flow {
                    ControlFlow::WaitUntil(u) if u <= until => ControlFlow::WaitUntil(u),
                    _ => ControlFlow::WaitUntil(until),
                };
            }
        }

        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            // 視窗大小改變：主 webview 跟著鋪滿。右下格的新位置由 JS 的 resize 事件回報。
            Event::WindowEvent { window_id, event: WindowEvent::Resized(_), .. } => {
                if window_id == window.id() {
                    let _ = main_view.set_bounds(full_window_rect(&window));
                } else if let Some(p) = peers.iter().find(|p| p.window.id() == window_id) {
                    let _ = p.view.set_bounds(full_window_rect(&p.window));
                }
            }
            Event::UserEvent(UserEvent::PeerIpc(k, msg)) => match msg {
                IpcMessage::Ready { resync } => {
                    if let Some(p) = peers.get_mut(k - 1) {
                        p.inflight = None;
                        if resync {
                            p.batch.resync();
                        }
                    }
                }
                IpcMessage::Log { msg } => match msg.strip_prefix("TICKBENCH|{") {
                    Some(rest) => eprintln!("[ui] TICKBENCH|{{\"win\":{k},{rest}"),
                    None => eprintln!("[ui#{}] {msg}", k + 1),
                },
                _ => {}
            },
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Bounds { x, y, w, h })) => {
                child_bounds = Rect {
                    position: PhysicalPosition::new(x.round() as i32, y.round() as i32).into(),
                    size: PhysicalSize::new(w.max(1.0).round() as u32, h.max(1.0).round() as u32).into(),
                };
                if let Some(wv) = web_view.as_ref() {
                    let _ = wv.set_bounds(child_bounds);
                }
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Quote { symbol })) => {
                if let Some(url) = quote_url(&symbol) {
                    if let Err(error) =
                        ensure_child_webview(&window, &proxy, &mut web_view, child_bounds, &url)
                    {
                        eprintln!("無法建立子 webview: {error}");
                    }
                }
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Log { msg })) => match msg.strip_prefix("TICKBENCH|{") {
                Some(rest) if !peers.is_empty() => eprintln!("[ui] TICKBENCH|{{\"win\":0,{rest}"),
                _ => eprintln!("[ui] {msg}"),
            },
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Save { data })) => {
                if let Some(path) = state_file.clone() {
                    let _ = save_tx.send((path, data));
                }
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Feed { symbols, chart, period })) => {
                let _ = feed_tx.send(engine::FeedCmd { symbols, chart, period });
            }
            Event::UserEvent(UserEvent::EnginePush(feed)) => match feed {
                // hello/down：立刻送；行情：合併，MainEventsCleared 時視 in-flight 狀態送出
                engine::Feed::Down => {
                    engine_batch.clear(); // 斷線後丟棄未刷行情，避免殘包晚到
                    engine_inflight = None;
                    let _ = main_view.evaluate_script("window.__enginePush&&window.__enginePush({down:true})");
                    for p in peers.iter_mut() {
                        p.batch.clear();
                        p.inflight = None;
                        let _ = p.view.evaluate_script("window.__enginePush&&window.__enginePush({down:true})");
                    }
                }
                engine::Feed::Hello(ready) => {
                    let js = format!("window.__enginePush&&window.__enginePush({{hello:{{ready:{ready}}}}})");
                    let _ = main_view.evaluate_script(&js);
                    for p in &peers {
                        let _ = p.view.evaluate_script(&js);
                    }
                }
                engine::Feed::Quotes { quotes, stamp } => {
                    for p in peers.iter_mut() {
                        p.batch.add_quotes_ref(&quotes, stamp);
                    }
                    engine_batch.add_quotes(quotes, stamp)
                }
                engine::Feed::Intraday(v) => {
                    for p in peers.iter_mut() {
                        p.batch.add_intraday(v.clone());
                    }
                    engine_batch.add_intraday(v)
                }
                engine::Feed::Minutes(bars) => {
                    for p in peers.iter_mut() {
                        p.batch.add_minutes(bars.clone());
                    }
                    engine_batch.add_minutes(bars)
                }
            },
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Ready { resync })) => {
                engine_inflight = None;
                if resync {
                    engine_batch.resync();
                }
            }
            Event::MainEventsCleared => {
                let due = engine_inflight.map_or(true, |t| t.elapsed() >= ENGINE_ACK_TIMEOUT);
                if due && engine_batch.has_data() {
                    let ev = tick_bench.then(engine::unix_us);
                    let (quotes, other) = engine_batch.take_scripts(ev);
                    if let Some(js) = other {
                        let _ = main_view.evaluate_script(&js);
                    }
                    if let Some(js) = quotes {
                        let _ = main_view.evaluate_script(js);
                        // 只有報價批會回 ready（分時／分鐘線很少，不佔 in-flight）
                        engine_inflight = Some(Instant::now());
                    }
                }
                for p in peers.iter_mut() {
                    let due = p.inflight.map_or(true, |t| t.elapsed() >= ENGINE_ACK_TIMEOUT);
                    if due && p.batch.has_data() {
                        let ev = tick_bench.then(engine::unix_us);
                        let (quotes, other) = p.batch.take_scripts(ev);
                        if let Some(js) = other {
                            let _ = p.view.evaluate_script(&js);
                        }
                        if let Some(js) = quotes {
                            let _ = p.view.evaluate_script(js);
                            p.inflight = Some(Instant::now());
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Home)) => {
                destroy_child_webview(&mut web_view, &proxy);
            }
            Event::UserEvent(UserEvent::Ipc(IpcMessage::Open { url })) => {
                // about:blank = 銷毀子 webview 釋放 WebKit RSS；其餘為真實分頁 URL
                if url == "about:blank" || url.starts_with("about:") {
                    destroy_child_webview(&mut web_view, &proxy);
                } else if url.starts_with("https://") || url.starts_with("http://") {
                    if let Err(error) =
                        ensure_child_webview(&window, &proxy, &mut web_view, child_bounds, &url)
                    {
                        eprintln!("無法建立子 webview: {error}");
                    }
                }
            }
            Event::UserEvent(UserEvent::Navigate(url)) => {
                if url.starts_with("https://") || url.starts_with("http://") {
                    if let Err(error) =
                        ensure_child_webview(&window, &proxy, &mut web_view, child_bounds, &url)
                    {
                        eprintln!("無法建立子 webview: {error}");
                    }
                }
            }
            Event::UserEvent(UserEvent::ChildLoaded(url)) => {
                // 含 about:blank：通知 JS 收起／維持深色占位，避免白閃；非 about 再回寫 URL
                let json = serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".into());
                let _ = main_view.evaluate_script(&format!(
                    "window.onChildLoaded && window.onChildLoaded({json});"
                ));
            }
            Event::UserEvent(UserEvent::MemStats { rss_mb, rss_max_mb, cpu_pct }) => {
                let script = format!(
                    "(function(){{var js=null;try{{if(performance&&performance.memory&&performance.memory.usedJSHeapSize)js=performance.memory.usedJSHeapSize/(1024*1024);}}catch(e){{}}if(window.setMemStats)window.setMemStats({{rssMb:{rss:.1},rssMaxMb:{mx:.1},cpuPct:{cpu:.1},jsHeapMb:js}});}})();",
                    rss = rss_mb, mx = rss_max_mb, cpu = cpu_pct,
                );
                let _ = main_view.evaluate_script(&script);
                for p in &peers {
                    let _ = p.view.evaluate_script(&script);
                }
            }
            _ => {}
        }
    });
}


/// XQ_WINDOWS 的其他視窗
struct PeerView {
    window: Window,
    view: WebView,
    batch: push::PushBatch,
    inflight: Option<Instant>,
}

/// 第 k 個視窗的初始狀態：沿用主視窗的設定，只把上方作用中的走勢圖分頁換成自選第 k 檔
/// （連同該分頁的指標設定 key 一起複製，畫面組成與主視窗相同）。
fn peer_state(saved: &str, k: usize) -> String {
    let Ok(mut v) = serde_json::from_str::<Value>(saved) else { return saved.to_string() };
    let Some(sym) = v
        .get("watchlist")
        .and_then(|w| w.get(k))
        .and_then(|s| s.as_str())
        .map(str::to_string)
    else {
        return saved.to_string();
    };
    let active = v.pointer("/panes/top/active").and_then(|a| a.as_str()).map(str::to_string);
    let mut old = None;
    if let Some(tabs) = v.pointer_mut("/panes/top/tabs").and_then(|t| t.as_array_mut()) {
        if let Some(tab) = tabs.iter_mut().find(|t| t.get("id").and_then(|i| i.as_str()) == active.as_deref()) {
            old = tab.get("symbol").and_then(|s| s.as_str()).map(str::to_string);
            tab["symbol"] = Value::String(sym.clone());
            tab["title"] = Value::String(sym.clone());
        }
    }
    if let (Some(old), Some(keys)) = (old, v.get_mut("keys").and_then(|k| k.as_object_mut())) {
        let add: Vec<(String, Value)> = keys
            .iter()
            .filter_map(|(key, val)| {
                let parts: Vec<&str> = key.split('|').collect();
                let i = parts.iter().position(|p| *p == old)?;
                let mut parts: Vec<String> = parts.iter().map(|p| p.to_string()).collect();
                parts[i] = sym.clone();
                Some((parts.join("|"), val.clone()))
            })
            .collect();
        for (key, val) in add {
            keys.entry(key).or_insert(val);
        }
    }
    v.to_string()
}

/// 銷毀右下子 webview（drop → WebKitWebProcess / NetworkProcess 退出），並通知 JS 空白占位。
fn destroy_child_webview(
    web_view: &mut Option<WebView>,
    proxy: &tao::event_loop::EventLoopProxy<UserEvent>,
) {
    if web_view.take().is_some() {
        // drop 即銷毀；稍後再通知，讓行程有機會先回收
    }
    let _ = proxy.send_event(UserEvent::ChildLoaded(HOME_URL.to_string()));
}

/// 確保子 webview 存在並載入 url；沿用上次 web-slot bounds。
fn ensure_child_webview(
    window: &Window,
    proxy: &tao::event_loop::EventLoopProxy<UserEvent>,
    web_view: &mut Option<WebView>,
    bounds: Rect,
    url: &str,
) -> wry::Result<()> {
    if let Some(wv) = web_view.as_ref() {
        let _ = wv.set_bounds(bounds);
        let _ = wv.load_url(url);
        return Ok(());
    }
    let load_proxy = proxy.clone();
    let popup_proxy = proxy.clone();
    let wv = WebViewBuilder::new()
        .with_bounds(bounds)
        .with_url(url)
        .with_on_page_load_handler(move |event, loaded| {
            if let PageLoadEvent::Finished = event {
                let _ = load_proxy.send_event(UserEvent::ChildLoaded(loaded));
            }
        })
        .with_new_window_req_handler(move |nav_url, _features| {
            let _ = popup_proxy.send_event(UserEvent::Navigate(nav_url));
            wry::NewWindowResponse::Deny
        })
        .build_as_child(window)?;
    *web_view = Some(wv);
    Ok(())
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
#[cfg(not(windows))]
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

#[cfg(not(windows))]
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

/// Windows：程序樹（本程式＋WebView2 的 msedgewebview2.exe 等子孫）——用 Toolhelp 快照找 parent。
#[cfg(windows)]
mod winproc {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub fn tree(root: u32) -> Vec<u32> {
        let mut pairs = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return vec![root];
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut e) != 0 {
                loop {
                    pairs.push((e.th32ProcessID, e.th32ParentProcessID));
                    if Process32NextW(snap, &mut e) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        let mut out = vec![root];
        let mut i = 0;
        while i < out.len() {
            let p = out[i];
            for &(c, pp) in &pairs {
                if pp == p && c != p && !out.contains(&c) {
                    out.push(c);
                }
            }
            i += 1;
        }
        out
    }

    fn ft(f: FILETIME) -> u64 {
        ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64
    }

    /// (工作集 bytes, kernel+user 100ns)
    fn proc_info(pid: u32) -> (u64, u64) {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return (0, 0);
            }
            let mut c: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let ws = if GetProcessMemoryInfo(h, &mut c, c.cb) != 0 { c.WorkingSetSize as u64 } else { 0 };
            let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut a, mut b, mut k, mut u) = (z, z, z, z);
            let t = if GetProcessTimes(h, &mut a, &mut b, &mut k, &mut u) != 0 { ft(k) + ft(u) } else { 0 };
            CloseHandle(h);
            (ws, t)
        }
    }

    pub fn rss_mb_tree(pid: u32) -> f64 {
        tree(pid).into_iter().map(|p| proc_info(p).0).sum::<u64>() as f64 / (1024.0 * 1024.0)
    }

    /// (程序樹 CPU 時間, 全系統所有核心的 kernel+user 時間)，單位都是 100ns；kernel 已含 idle
    pub fn read_proc_times(pid: u32) -> (u64, u64) {
        let proc_t = tree(pid).into_iter().map(|p| proc_info(p).1).sum();
        let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut idle, mut k, mut u) = (z, z, z);
        let total = unsafe { if GetSystemTimes(&mut idle, &mut k, &mut u) != 0 { ft(k) + ft(u) } else { 0 } };
        (proc_t, total)
    }
}
#[cfg(windows)]
use winproc::{read_proc_times, rss_mb_tree};

fn cpu_pct(prev: (u64, u64), now: (u64, u64)) -> f64 {
    let dp = now.0.saturating_sub(prev.0) as f64;
    let dt = now.1.saturating_sub(prev.1) as f64;
    if dt <= 0.0 { return 0.0; }
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
    (dp / dt) * cpus * 100.0
}

#[cfg(test)]
mod tests {
    use super::peer_state;
    use serde_json::{json, Value};

    #[test]
    fn peer_state_switches_active_chart_and_copies_indicator_keys() {
        let saved = json!({
            "watchlist": ["2330", "2317", "2454"],
            "keys": {"2330|D": {"cfg": 1}, "chart-1|2330|D": {"cfg": 2}, "2317|W": {"cfg": 3}},
            "panes": {"top": {"active": "chart-1", "tabs": [
                {"id": "chart-1", "kind": "chart", "period": "D", "symbol": "2330", "title": "2330 台積電"},
                {"id": "chart-2", "kind": "chart", "period": "W", "symbol": "2317", "title": "2317"}]}}
        })
        .to_string();
        let v: Value = serde_json::from_str(&peer_state(&saved, 2)).unwrap();
        assert_eq!(v["panes"]["top"]["tabs"][0]["symbol"], "2454");
        assert_eq!(v["panes"]["top"]["tabs"][1]["symbol"], "2317");
        assert_eq!(v["keys"]["chart-1|2454|D"], json!({"cfg": 2}));
        assert_eq!(v["keys"]["2454|D"], json!({"cfg": 1}));
        assert_eq!(v["keys"]["2330|D"], json!({"cfg": 1}));
        // 沒有狀態／超出自選：原樣
        assert_eq!(peer_state("null", 1), "null");
        assert_eq!(peer_state(&saved, 9), saved);
    }
}
