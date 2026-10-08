//! 從 XQNext 行程裡的 WryFeedHost（127.0.0.1:47631）收已合併的行情。
//! 封包是 little-endian：u32 長度 + payload。不自己連 DAQEngine。

use std::io::{Read, Write};
use std::net::{TcpStream, SocketAddr};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tao::event_loop::EventLoopProxy;

pub const PORT: u16 = 47631;

#[derive(Debug, Clone)]
pub struct FeedCmd {
    pub symbols: Vec<String>,
    pub chart: String,
    pub period: String,
}

pub fn spawn<T: Send + 'static>(proxy: EventLoopProxy<T>, rx: Receiver<FeedCmd>, mut to_event: impl FnMut(Value) -> T + Send + 'static) {
    thread::spawn(move || {
        // XQ_FEED_ADDR=host:port 可覆寫（壓測／開發用，同 GPUI 版）；預設 127.0.0.1:47631
        let addr: SocketAddr = std::env::var("XQ_FEED_ADDR")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| ([127, 0, 0, 1], PORT).into());
        let mut latest: Option<FeedCmd> = None;
        loop {
            match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
                Ok(stream) => {
                    eprintln!("[engine] 已連上 XQNext {addr}");
                    if let Err(error) = session(stream, &rx, &mut latest, &proxy, &mut to_event) {
                        eprintln!("[engine] 連線中斷: {error}");
                    }
                    let _ = proxy.send_event(to_event(json!({ "down": true })));
                }
                Err(_) => {
                    while let Ok(cmd) = rx.try_recv() {
                        latest = Some(cmd);
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }
    });
}

fn session<T>(
    mut stream: TcpStream,
    rx: &Receiver<FeedCmd>,
    latest: &mut Option<FeedCmd>,
    proxy: &EventLoopProxy<T>,
    to_event: &mut impl FnMut(Value) -> T,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_millis(200)))?;
    stream.set_nodelay(true)?;
    if let Some(cmd) = latest.clone() {
        write_subscribe(&mut stream, &cmd)?;
    }
    // 讀取逾時時保留已到的位元組，避免半包被丟掉後整條連線錯位。
    let mut pending = Vec::new();
    let bench = tick_bench_enabled();
    loop {
        loop {
            match rx.try_recv() {
                Ok(cmd) => {
                    write_subscribe(&mut stream, &cmd)?;
                    *latest = Some(cmd);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Ok(()),
            }
        }
        match read_frame(&mut stream, &mut pending) {
            Ok(payload) => {
                if let Some(mut value) = decode(&payload) {
                    if bench {
                        annotate_stamp(&payload, &mut value);
                    }
                    let _ = proxy.send_event(to_event(value));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut || error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error),
        }
    }
}

/// XQ_TICK_BENCH=1（高頻進價壓測，預設關閉）：解析產生器附在報價包尾端的
/// `b"XQTS" + seq u64 + sent_us u64`（見 gpui-xq-demo/crates/xq-feed），一般解碼本來就忽略這段尾巴。
pub fn tick_bench_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("XQ_TICK_BENCH").is_some_and(|v| v != "0"))
}

pub fn unix_us() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

/// 在解碼結果加上 `stamp: [seq, sent_us, recv_us]` 與 `raw: 筆數`（未合併）。
fn annotate_stamp(payload: &[u8], value: &mut Value) {
    let Some(obj) = value.as_object_mut() else { return };
    let Some(n) = obj.get("quotes").and_then(|q| q.as_array()).map(|a| a.len()) else { return };
    obj.insert("raw".into(), json!(n));
    if payload.len() < 23 || payload[payload.len() - 20..payload.len() - 16] != *b"XQTS" {
        return;
    }
    let t = &payload[payload.len() - 16..];
    let seq = u64::from_le_bytes(t[..8].try_into().unwrap());
    let sent = u64::from_le_bytes(t[8..].try_into().unwrap());
    obj.insert("stamp".into(), json!([seq, sent, unix_us()]));
}

fn write_subscribe(stream: &mut TcpStream, cmd: &FeedCmd) -> std::io::Result<()> {
    let chart_on = cmd.period.eq_ignore_ascii_case("T") && !cmd.chart.is_empty();
    let mut body = Vec::with_capacity(64);
    body.push(1);
    body.push(if chart_on { 1 } else { 0 });
    push_text(&mut body, &cmd.chart);
    let symbols: Vec<&str> = cmd.symbols.iter().map(String::as_str).take(64).collect();
    body.extend_from_slice(&(symbols.len() as u16).to_le_bytes());
    for symbol in symbols {
        push_text(&mut body, symbol);
    }
    stream.write_all(&(body.len() as u32).to_le_bytes())?;
    stream.write_all(&body)?;
    Ok(())
}

fn push_text(body: &mut Vec<u8>, text: &str) {
    let bytes = text.as_bytes();
    let n = bytes.len().min(96);
    body.push(n as u8);
    body.extend_from_slice(&bytes[..n]);
}

fn read_frame(stream: &mut TcpStream, pending: &mut Vec<u8>) -> std::io::Result<Vec<u8>> {
    loop {
        if let Some(payload) = take_frame(pending)? {
            return Ok(payload);
        }
        let mut tmp = [0u8; 8192];
        match stream.read(&mut tmp) {
            Ok(0) => {
                return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "closed"));
            }
            Ok(n) => pending.extend_from_slice(&tmp[..n]),
            Err(error) => return Err(error),
        }
    }
}

fn take_frame(pending: &mut Vec<u8>) -> std::io::Result<Option<Vec<u8>>> {
    if pending.len() < 4 {
        return Ok(None);
    }
    let n = u32::from_le_bytes([pending[0], pending[1], pending[2], pending[3]]) as usize;
    if n == 0 || n > 8_000_000 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad frame"));
    }
    if pending.len() < 4 + n {
        return Ok(None);
    }
    let payload = pending[4..4 + n].to_vec();
    pending.drain(..4 + n);
    Ok(Some(payload))
}

fn decode(payload: &[u8]) -> Option<Value> {
    match *payload.first()? {
        1 => Some(json!({ "hello": { "ready": payload.get(1).copied().unwrap_or(0) == 1 } })),
        2 => decode_quotes(payload),
        3 => decode_intraday(payload),
        4 => decode_minutes(payload),
        _ => None,
    }
}

struct Cursor<'a> {
    buf: &'a [u8],
    i: usize,
}

impl<'a> Cursor<'a> {
    fn u8(&mut self) -> Option<u8> {
        let v = *self.buf.get(self.i)?;
        self.i += 1;
        Some(v)
    }
    fn u16(&mut self) -> Option<u16> {
        let b = self.buf.get(self.i..self.i + 2)?;
        self.i += 2;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }
    fn i32(&mut self) -> Option<i32> {
        let b = self.buf.get(self.i..self.i + 4)?;
        self.i += 4;
        Some(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn i64(&mut self) -> Option<i64> {
        let b = self.buf.get(self.i..self.i + 8)?;
        self.i += 8;
        Some(i64::from_le_bytes(b.try_into().ok()?))
    }
    fn text(&mut self) -> Option<String> {
        let n = self.u8()? as usize;
        let b = self.buf.get(self.i..self.i + n)?;
        self.i += n;
        Some(String::from_utf8_lossy(b).into_owned())
    }
}

fn px(v: i32) -> f64 {
    v as f64 / 100.0
}

fn decode_quotes(payload: &[u8]) -> Option<Value> {
    let mut c = Cursor { buf: payload, i: 1 };
    let n = c.u16()? as usize;
    let mut quotes = Vec::with_capacity(n);
    for _ in 0..n {
        let symbol = c.text()?;
        let name = c.text()?;
        let price = px(c.i32()?);
        let change = px(c.i32()?);
        let volume = c.i64()?;
        quotes.push(json!({ "symbol": symbol, "name": name, "price": price, "change": change, "volume": volume }));
    }
    Some(json!({ "quotes": quotes }))
}

fn take_bar(c: &mut Cursor<'_>) -> Option<Value> {
    let t = c.u16()?;
    let o = px(c.i32()?);
    let h = px(c.i32()?);
    let l = px(c.i32()?);
    let close = px(c.i32()?);
    let v = c.i64()?;
    Some(json!([t, o, h, l, close, v]))
}

fn decode_intraday(payload: &[u8]) -> Option<Value> {
    let mut c = Cursor { buf: payload, i: 1 };
    let symbol = c.text()?;
    let prev = px(c.i32()?);
    let n = c.u16()? as usize;
    let mut bars = Vec::with_capacity(n);
    for _ in 0..n {
        bars.push(take_bar(&mut c)?);
    }
    Some(json!({ "intraday": { "symbol": symbol, "prev": prev, "bars": bars } }))
}

fn decode_minutes(payload: &[u8]) -> Option<Value> {
    let mut c = Cursor { buf: payload, i: 1 };
    let symbol = c.text()?;
    let n = c.u16()? as usize;
    let mut minutes = Vec::with_capacity(n);
    for _ in 0..n {
        let bar = take_bar(&mut c)?;
        minutes.push(json!({ "symbol": symbol, "bar": bar }));
    }
    Some(json!({ "minutes": minutes }))
}
