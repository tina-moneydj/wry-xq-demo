# Windows 安裝檔（Inno Setup）

產出：`dist/wry-xq-demo-setup-0.1.0.exe`（繁中精靈、每使用者安裝、開始功能表／可選桌面捷徑、完成頁可勾選啟動）。

## 一鍵打包（Linux 交叉編譯 + Wine ISCC）

需求：

- Rust toolchain + `x86_64-pc-windows-gnu` target
- `gcc-mingw-w64-x86-64`（Debian／Ubuntu）
- 已安裝的 Inno Setup（本環境預設 Wine prefix：`/workspace/xq-installer/wine-inno`，內含 `ChineseTraditional.isl`）

```bash
./scripts/package-windows.sh
```

略過重新編譯（已有 `target/x86_64-pc-windows-gnu/release/wry-xq-demo.exe`）：

```bash
XQ_SKIP_BUILD=1 ./scripts/package-windows.sh
```

## 在 Windows 上編譯（建議正式發行用 MSVC）

WebView2／tao／wry 在 Windows 上以 **MSVC** 工具鏈最穩；本倉庫在 Linux 上可用 **gnu** 交叉編譯出可用 PE，但正式發佈仍建議在 Windows 本機：

```bat
rustup target add x86_64-pc-windows-msvc
cargo build --release --target x86_64-pc-windows-msvc
```

接著把 `wry-xq-demo.exe` 與 `WebView2Loader.dll`（來自 `webview2-com-sys` 的 `x64/`）放到 `installer\staging\`，再用 Inno Setup Compiler 開啟 `installer\wry-xq-demo.iss` 編譯。

或在 Git Bash／WSL（已掛好 Wine Inno）執行：

```bash
XQ_SKIP_BUILD=1 XQ_WIN_TARGET=x86_64-pc-windows-msvc ./scripts/package-windows.sh
```

## 安裝內容

| 檔案 | 說明 |
|------|------|
| `wry-xq-demo.exe` | 主程式（UI 已 `include_str` 進二進位） |
| `WebView2Loader.dll` | WebView2 載入器（與 exe 同目錄） |
| `README.txt` | 簡易說明 |

執行階段仍需系統 **WebView2 Runtime**（非 Evergreen Bootstrapper 時請預先安裝）。

## 已知限制

- Linux 交叉目標為 `x86_64-pc-windows-gnu`（MinGW）。`x86_64-pc-windows-msvc` 需 Windows SDK／MSVC 或 `cargo-xwin`，本 Linux 箱未完整配置。
- 右下預設網頁為 `about:blank`（勿改回外站）。
- FeedHost（XQNext）為獨立 .NET 專案，**未**打進此安裝檔。
