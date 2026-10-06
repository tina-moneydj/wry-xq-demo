# wry-xq-demo

XQ 風格的測試程式：Rust（tao + wry）開視窗，畫面用 HTML/JS 畫。

- 上方：技術分析圖（分時／日K／週K／月K、均線、EMA、布林、SAR、KD、MACD、RSI、威廉、DMI、ATR、OBV，畫線工具含黃金分割）
- 左下：報價（假的示範資料）
- 右下：真正的網頁（子 webview，跟著分割線移動）
- 分割線可拖拉；畫線與指標設定會存檔

![screenshot](docs/screenshot.png)

## 執行

需要 Rust 1.88 以上。Windows 需 WebView2（Windows 10/11 內建）。Linux 需 WebKitGTK 4.1，嵌入網頁只支援 X11。

```
cargo run
```

報價與走勢都是假的示範資料，不是即時行情。
