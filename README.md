# wry-xq-demo

XQ 風格桌面示範：Rust（**tao** 視窗 + **wry** WebView）開原生視窗，畫面以 HTML／CSS／JS 繪製。

![screenshot](docs/screenshot.png)

## 架構（tao + wry）

- **主 WebView**：鋪滿視窗，負責三格版面、走勢圖 Canvas、報價／自選／記事、分割線與狀態列。
- **子 WebView**：疊在右下格，載入**真實網站**（不受 `X-Frame-Options` 限制）。JS 以 `ipc` 回報格位像素，Rust 呼叫 `set_bounds` 跟著分割線移動。
- Linux 主畫面走 GTK 嵌入；右下子 WebView 仍為 X11 子視窗（**僅支援 X11**，Wayland 不行）。Windows／macOS 兩個 WebView 皆為視窗子元件。

## 三格版面與分頁

| 區塊 | 分頁 |
|------|------|
| **上** 走勢圖 | 獨立圖表分頁，軟上限 **16**；各分頁自有代號／週期／畫線／指標（鍵：`tabId\|symbol\|period`） |
| **左下** | **報價**、**自選**、**組合**（虛擬化大表）、**記事**（可多開） |
| **右下** 網頁 | 多個網頁分頁共用同一個子 WebView；切走後**延遲約 20 秒**再載入新頁／卸載（期間切回可保暖、深色占位減白閃），逾時釋放 Yahoo 等重站 RSS |

分割線可水平／垂直拖拉；點報價可同步上方圖表與右下網頁。

## 畫線工具列（Longbridge 風格）

走勢圖左側常駐垂直工具列（`draw-rail`）：游標、趨勢線、射線、水平／垂直線、平行通道、費波納契回撤、矩形、文字註記，以及刪除／全部清除。作用中工具會高亮；週期與「指標」仍在上方工具列。

## 技術指標

- **主圖疊加**（overlays）：最多 **20** 組實例，可重複同類型不同參數 — MA、EMA、布林、SAR。
- **副圖**：最多 **10** 格，一律排在主圖下方、與 K 線共用時間軸；指標含成交量、KD、MACD、RSI、威廉、DMI、ATR、OBV。
- 週期：分時／日 K／週 K／月 K。

## 畫線與持久化

畫線與指標、分頁、自選、記事等寫入 `window.XQ_STATE`，經 ipc `{type:"save"}` 由 Rust 存成 JSON：

- Windows：`%APPDATA%\wry-xq-demo\state.json`
- macOS：`~/Library/Application Support/wry-xq-demo/state.json`
- Linux：`$XDG_DATA_HOME/wry-xq-demo/state.json`（或 `~/.local/share/...`）

下次啟動以初始化腳本注入（比 `localStorage` 可靠；WebView2 的 `with_html` 頁面為 `about:blank`）。


## 組合／報價大表（虛擬化）

左下 **組合** 分頁：針對交易室等級的自選／族群表。

- **規模**：單一組合可載入 **5 萬+** 檔（合成假資料做壓力測試；合成組合**不寫入** `state.json`）。
- **欄位**：使用者可增刪／重排／改名／調寬，硬上限 **100** 欄；設定與可編輯組合的代號清單非同步寫入 `state.json`。
- **效能**：列＋欄雙向虛擬化（只建可見 DOM）；行情 tick 只標記髒列、rAF 增量更新可見格；禁止整表重建。
- **編輯**：工具列可加代號、編輯代號清單、編輯欄位；拖曳表頭右緣調寬。
- 壓測：`XQ_GROUP_STRESS=1` 啟動後自動跑 5 萬列 × 多欄 + 高頻 tick + 捲動，結果以 `GROUPPERF|…` 印到 stderr。

## 狀態列

視窗底部顯示 **記憶體**（主行程 + WebView／WebKit 子行程 RSS）、**JS 堆**（有則顯示）、**FPS**（獨立 rAF 計幀）。約每秒更新，**不走行情 tick 熱路徑**。

## 執行

需求：

- **Rust ≥ 1.88**（見 `Cargo.toml` 的 `rust-version`）
- **Windows**：WebView2（Windows 10／11 多半內建）
- **Linux**：WebKitGTK 4.1，嵌入網頁僅 **X11**
- **macOS**：系統 WebKit

```bash
cargo run
# 建議日常／測記憶體用 Release（比 debug 明顯省 CPU／RSS）
cargo run --release
```

選用環境變數：`XQ_DEBUG=1`（ipc 除錯）、`XQ_TAB_STRESS=1`（16 走勢圖分頁切換壓測）、`XQ_GROUP_STRESS=1`（組合表 5 萬列壓測；可用 `XQ_STRESS_COLS`／`XQ_STRESS_TICK_HZ`／`XQ_STRESS_TICK_MS`／`XQ_STRESS_SCROLL_MS` 改欄數、跳價頻率與時間，預設 40 欄、3000 筆/s、各 2 秒）、`XQ_BENCH=1`（第一幀／第一筆報價／每秒 FPS 印到 stderr，給 `scripts/bench-main-window.sh` 用）。

### 記憶體：右下網頁延遲卸載（少閃）

子 WebView 同時只常駐**一個**頁面。切到其他網頁分頁時：

1. **先深色占位**並把子 WebView 縮成 1×1（不露 `about:blank` 白屏）。
2. **約 20 秒內**仍保留上一頁在 WebKit（保暖）；期間切回上一分頁可**立即顯示**。
3. 逾時或按「立即載入」才導向新 URL（同時釋放舊頁 RSS，例如 Yahoo 可省約數百 MB）。
4. 載入完成前維持占位，完成後再鋪回子 WebView。

啟動、新分頁、首頁仍會立即載入。分頁標題與 URL 仍寫在 `state.json`。雙 WebView 架構不變。

標題列可選「假資料」或「Engine」。假資料不向 XQNext 訂閱；Engine 的報價與分時來自 XQNext（經本機 WryFeedHost），日 K 仍是合成的，最後一根跟著現價。

## Engine 行情（WryFeedHost）

真實報價／分時由旁邊的 **WryFeedHost**（`feedhost/`）推到 `127.0.0.1:47631`，協定與 `src/engine.rs` 一致（LE u32 長度前綴二進位；**不要**在 hot path 用 JSON）。

### Windows（建議：XQNext 旁掛）

1. 啟動並**登入** XQNext（需要 SysJust 帳密／token；未登入則 `hello.ready=0`，沒有即時行情）。
2. 編譯並執行 WryFeedHost：

   ```bat
   cd feedhost
   dotnet build -c Release
   dotnet run --project WryFeedHost -c Release
   ```

3. 再 `cargo run` 本專案，標題列選 **Engine**。

- **空訂閱**（0 個代號，例如切回「假資料」）= 取消訂閱／放下 FieldPool。
- 目前 `EngineBridge` 已接好 TCP 協定與訂閱狀態機；真正的 `RT_RefQuote2`／`KData_Min`／FieldPool 仍需在 Windows 上接 `DAQEngine.Client`（套件提示 `XQData.DAQEngine.Client` 0.43.0）與登入憑證。詳見 [feedhost/README.md](feedhost/README.md)。

### Linux／Wine 限制

XQNext 的 WPF UI 在 Wine 下會因字型等問題崩潰；即便 Engine 行程起來，**Named Pipe 也不會出現**，無法當正式即時源。請在 **Windows** 上跑 XQNext + WryFeedHost。

### 協定路徑測試（非即時）

```bash
dotnet run --project feedhost/WryFeedHost -c Release -- --demo-ticks
```

清楚標示為 **path-test**，推送合成高頻二進位報價／分鐘線，**不是**嘉實即時行情。


## Windows 安裝檔

Inno Setup 繁中安裝程式腳本與打包說明見 [installer/README.md](installer/README.md)。

```bash
# Linux：交叉編譯 x86_64-pc-windows-gnu + Wine 編譯 Inno → dist/wry-xq-demo-setup-0.1.0.exe
./scripts/package-windows.sh
```

正式發佈建議在 Windows 用 MSVC 編譯後再跑同一腳本（或手動開 `installer/wry-xq-demo.iss`）。安裝後右下網頁分頁預設仍為空白（`about:blank`）。

## 文件

- [效能設計原則](docs/performance-principles.md) — HFT 看盤心態、增量更新、虛擬化、畫線／分頁快取、壓測數字與檢查清單。

## 效能備註（壓力測試摘要）

測試環境：Linux WebKitGTK、無獨立 GPU（偏悲觀；Windows WebView2 + GPU 通常更快）。Canvas 2D。

- **畫線快取**：靜態畫線離屏快取 + 空間索引 hitTest；混合 1000 筆工具重繪約 **15.5 ms → ~0.9 ms**。
- **最重負載**（20 疊加、8 副圖、1000 畫線 + 高頻 tick）：連續 tick 約 **~38 FPS**；十字線+tick ~32 FPS；平移因重建畫線層較慢（~27 FPS）。輕量基準約 60 FPS；RSS 約 600–750 MB（含 WebKit）。
- **組合表**（Linux WebKitGTK）：5 萬列 × 40 欄、~3000 tick/s → **tick ~61 FPS**、捲動 **~55 FPS**、scroll jank 0、可見格重繪 ~1 ms；RSS（含 WebKit）約 **1.1 GB**（合成 5 萬列常駐記憶體）。硬上限 100 欄。
- **16 走勢圖分頁**：切換先貼快照再延遲完整重繪；`paintFirst` 約 **3–4 ms**（p95），settle（含完整 render）約 **~57 ms**。另有 series LRU、平移 translate-cache、指標末棒增量更新等。

## 主視窗成本比較（wry vs GPUI）

同一個行情來源、同一份畫面內容，各開**一個主視窗**的成本。對照專案：[tina-moneydj/gpui-xq-demo](https://github.com/tina-moneydj/gpui-xq-demo)（GPUI 原生繪圖版）。

- **測試日期**：2026-10-08（Asia/Taipei 12:24–12:35）；每個情境兩邊各跑 **3 次取中位數**，兩個程式輪流跑（WryFeedHost 一次只服務一個 client）。
- **環境**：Linux box（Debian 13，kernel 6.12，8 vCPU Intel Xeon，**沒有 GPU**），Xvfb `:2` 1280×800＋xfwm4（X11）。
  wry 版＝WebKitGTK 2.54（`WEBKIT_DISABLE_COMPOSITING_MODE=1`）；GPUI 版＝`gpui-pre 0.3.7` 走 Vulkan，由 **Mesa 25.0.7 lavapipe 軟體光柵**。
  行情：`WryFeedHost --demo-ticks`（合成資料，約 30 包／900 筆報價每秒），測前重啟過 feedhost。兩邊都是 release build。
- **同樣的畫面**：視窗 1200×720、33 檔自選（同 `gpui-xq-demo/src/names.rs`）、單一走勢圖＝**2330 日線（合成日 K）＋MA5/20/60＋成交量**、
  左下報價表 6 欄（代號／名稱／成交／漲跌／幅度／總量）、右下空白（wry 是 `about:blank`，**不建子 WebView**；GPUI 是資訊格）、不開壓力 5 萬。
  wry 的 `state.json` 測試時換成同內容的最小設定（1 個走勢分頁、左下只有「組合」分頁），測完還原。
- **方法**（[`scripts/bench-main-window.sh`](scripts/bench-main-window.sh)，可重跑：`scripts/bench-main-window.sh 3 all`）：
  - 啟動：launch → 視窗出現（`xdotool` 輪詢）→ 第一幀畫完／第一筆報價畫上畫面（程式在 `XQ_BENCH=1` 時印 `BENCH first-frame`／`BENCH first-quote`，腳本收到時打時間戳）。
  - 記憶體：主行程＋所有子行程（wry：`WebKitWebProcess`、`WebKitNetworkProcess`）的 RSS，以及 PSS（`/proc/*/smaps_rollup`，共用函式庫按比例分攤，比較公平）。
  - CPU：所有行程（含所有執行緒）`utime+stime` 在 30 秒內的平均；100% = 一顆核心。另外依執行緒名稱拆出「軟體光柵（`llvmpipe` 執行緒）」佔多少。
  - FPS：程式自己回報（wry：狀態列 rAF 計幀；GPUI：每秒實際畫出的 frame 數），取 30–60 秒平均。

### 一般情境（開一個主視窗、行情持續跳動）

| 項目（中位數，3 次） | wry（tao + wry / WebKitGTK） | GPUI（原生繪圖） |
|---|---|---|
| 啟動 → 視窗出現 | 228 ms | 261 ms |
| 啟動 → 第一幀畫完 | 986 ms | **285 ms** |
| 啟動 → 第一筆報價上畫面 | 917 ms¹ | **398 ms** |
| RSS 合計，t=10s | 600 MB | **182 MB** |
| RSS 合計，t=60s | 674 MB（主程式 195＋WebKitWebProcess 413＋Network 60）² | **182 MB**（單一行程） |
| PSS 合計，t=10s / t=60s | 414 / 477 MB | **178 / 178 MB** |
| 行程數／執行緒數 | 3／80 | **1／53** |
| CPU（30 秒平均，全部行程） | **181%** | 246% |
| 　└ 其中軟體光柵（llvmpipe 執行緒）³ | ≈ 102% | ≈ 224% |
| 　└ 扣掉軟體光柵（程式本身＋瀏覽器引擎）³ | ≈ 79%（WebKit 主執行緒 65%、wry 主程式 8%） | **≈ 22%** |
| FPS（程式回報） | 59.5（rAF 計幀，不代表每幀都有重畫） | 27.7（實際畫出的幀；被 lavapipe 每幀約 30 ms 卡住） |
| 執行檔大小 | **1.6 MB**（另需系統 WebKitGTK 4.1：`libwebkit2gtk` 96 MB＋`libjavascriptcoregtk` 33 MB；Windows 用系統 WebView2，安裝檔 3.1 MB） | 25.1 MB（單一執行檔，strip＋thin LTO；只需 Vulkan/GL 驅動） |

¹ wry 的第一筆報價和第一幀幾乎落在同一幀（兩個標記都是「兩次 rAF 後」送出，順序會互換）。
² wry 的 RSS 在開頭 60 秒內會從 600 爬到 674 MB（JS heap／WebKit 快取暖身）；GPUI 從第 10 秒起就持平。
³ 執行緒拆分取第 3 次的數字。

### 壓力情境（5 萬列報價表＋高頻跳價＋捲動）

兩邊都開 **5 萬列合成表、6 欄**，每秒 **3000 筆合成跳價**（30 Hz 分批、隨機挑列，同 wry 版 `applyTicks`），
先只跳價 **30 秒**、再邊跳價邊上下正弦捲動 **10 秒**；行情 feed 照常進來。
wry：`XQ_GROUP_STRESS=1 XQ_STRESS_COLS=6 XQ_STRESS_TICK_MS=30000 XQ_STRESS_SCROLL_MS=10000`；
GPUI：`XQ_GROUP_STRESS=1`（同一組 `XQ_STRESS_*` 參數），結果都以 `GROUPPERF|{json}` 印出。

| 項目（中位數，3 次） | wry | GPUI |
|---|---|---|
| RSS／PSS，跳價 30 秒時（約 t=32s） | 623／426 MB | **187／183 MB**（比一般情境只多 ≈ 4 MB） |
| RSS／PSS，捲動中（約 t=40s） | 647／456 MB | **186／183 MB** |
| CPU，跳價 30 秒 | **171%** | 298%（其中 llvmpipe ≈ 272%） |
| CPU，捲動 10 秒 | **192%** | 305% |
| FPS，跳價中 | 59.5（rAF） | 35.8（實際幀） |
| FPS，捲動中 | 59.7（rAF） | 35.5（實際幀） |
| 捲動卡頓（幀間隔 > 32 ms） | 1 次（平均 35 ms） | 140 次（平均 33.1 ms，即穩定 ~30 fps 的幀距） |
| 可見格更新，跳價中 | 0.36 ms／次、約 1 格／次（只重畫髒列；30 秒 769 次） | **0.09 ms**／次、84 格／次（整個可見範圍重建；30 秒 1074 次） |
| 可見格更新，捲動中 | 1.15 ms／次、120 格／次（10 秒 834 次） | **0.09 ms**／次、84 格／次（10 秒 355 次） |

兩邊的差異（盡量對齊，但仍不完全相同）：
- 表格內容：wry 是純合成組合（50,000 列）；GPUI 是 33 檔真實自選＋50,000 合成列（最上面是真實列）。
- 更新策略：wry 只重畫「可見且有變」的格；GPUI 每次表格有變就重建整個可見範圍（14 列×6 欄），但每次只要 ~0.09 ms。
- 「可見格更新」只算組資料的時間：wry＝JS 組 DOM 字串＋`innerHTML`；GPUI＝建立可見列的元素樹。都**不含**版面計算與光柵化。
- 捲動驅動：wry 用 rAF（跟顯示同步）；GPUI 用 16 ms 計時器。可見列數：wry 約 20 列（含 overscan）、GPUI 14 列。
- FPS 定義不同（見上表）。

### 結論

- **記憶體**：GPUI 版約是 wry 版的 **1/3.7（RSS 182 vs 674 MB）**，PSS 也只有 **~37%**（178 vs 477 MB），而且只有一個行程、不隨時間增長；
  5 萬列壓力表對兩邊都不太加記憶體（虛擬化），GPUI 只多約 4 MB。
- **啟動**：視窗出現時間差不多（~0.25 s），但 GPUI **~0.3 s 就畫出內容**、0.4 s 有報價；wry 要等 WebKit 子行程起來、載入 HTML/JS，約 **0.9–1.0 s**。
- **CPU／FPS（這台沒有 GPU）**：GPUI 看起來比較吃 CPU、FPS 也較低，原因是 lavapipe 用 CPU 光柵化**整個視窗每一幀**（佔它 CPU 的 ~90%）；
  扣掉軟體光柵，GPUI 本身只用 **~22%**，wry（WebKit 主執行緒＋主程式）約 **~79%**。有實體 GPU 時 GPUI 的光柵化交給 GPU，CPU 與 FPS 會大幅改善；
  wry 在 Windows／macOS 也會改用 GPU 合成，數字同樣會不同。
- GPUI 表格還能再省：只在跳價的列落在可見範圍時才 `notify`（wry 版已經這樣做）。

### 注意事項

- 這是**沒有 GPU 的 Linux／Xvfb**：兩邊都靠 Mesa 軟體光柵（WebKit 也有 ~100% 的 `llvmpipe` 執行緒）。Windows（WebView2／DirectX）、macOS（WKWebView／Metal）的絕對數字會不同，請在目標機器重跑。
- wry 的 FPS 是 rAF 回呼次數（主執行緒沒被卡住就接近 60），GPUI 的 FPS 是實際畫出的幀數（沒變化就不畫），**兩者不能直接比**；看卡不卡要對照捲動卡頓與 CPU。
- demo-ticks 價格有向上漂移，測試約 25 分鐘內 2330 漲了 ~70%（假資料特性，不影響成本量測）。
- RSS 會重複計算共用函式庫（WebKit 三個行程共用很多 .so），所以同時列 PSS。
- 截圖（t≈60s／壓力跳價中）：

| wry | GPUI |
|---|---|
| ![wry 一般情境](docs/bench/wry.png) | ![GPUI 一般情境](docs/bench/gpui.png) |
| ![wry 壓力情境](docs/bench/wry-stress.png) | ![GPUI 壓力情境](docs/bench/gpui-stress.png) |

原始數據：[`docs/bench/summary.json`](docs/bench/summary.json)、[`docs/bench/results.json`](docs/bench/results.json)。

## 儲存庫

私人 GitHub 專案：[tina-moneydj/wry-xq-demo](https://github.com/tina-moneydj/wry-xq-demo)（需有權限才能 clone）。
