// XQ 風格的測試程式：Rust (tao) 開視窗，裡面放兩個 webview。
// - 主 webview：鋪滿整個視窗，用 HTML/CSS/JS 畫出走勢圖、報價、分割線。
// - 子 webview：疊在右下格上面，載入真正的網站（不受 X-Frame-Options 限制）。
// 網頁 JS 會把右下格的位置用 window.ipc.postMessage 傳回來，Rust 再呼叫 set_bounds。
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::path::PathBuf;

use serde::Deserialize;
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
}

/// 從 webview 回呼送到主執行緒事件迴圈的事件。
#[derive(Debug)]
enum UserEvent {
    Ipc(IpcMessage),
    Navigate(String),
    ChildLoaded(String),
}

fn main() -> wry::Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

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
    let init_script = format!(
        "window.XQ_STATE = {saved_state};{}",
        if debug { " window.XQ_DEBUG = true;" } else { "" }
    );

    // 1) 主 webview（先建立，在下層）。
    let ipc_proxy = proxy.clone();
    let main_builder = WebViewBuilder::new()
            .with_bounds(full_window_rect(&window))
            .with_initialization_script(&init_script)
            .with_html(UI_HTML.replace("/*__CHART_JS__*/", CHART_JS))
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
                if let Some(path) = &state_file {
                    if let Err(error) = save_state(path, &data) {
                        eprintln!("無法儲存設定到 {}: {error}", path.display());
                    }
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
