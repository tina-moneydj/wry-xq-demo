//! Rust → 主 WebView 的行情推送：合併＋節流＋精簡格式。
//!
//! - **合併**：兩次推送之間，同代號只留最新一筆（O(1)：代號 → 固定 id → 本批位置）。
//!   成交量是當日累計，留最新就等於把中間的量都累加進去；另外記本批內的最高／最低價，
//!   讓走勢圖最後一根與表格的高低不會因為合併漏掉中間的極值。分鐘線依 (代號, 分鐘) 合併：
//!   同一分鐘 h=max、l=min、c/v 取最新，不同分鐘依序保留（不會吃掉上一分鐘的收尾）。
//! - **節流**：一次最多一批在網頁裡（in-flight = 1）。網頁套用後在下一個 rAF 回 `ready`，
//!   Rust 才推下一批 → 每個顯示幀最多一次 evaluate_script；網頁忙的時候資料留在 Rust 這邊合併，
//!   不會在 WebKit 的 IPC 佇列裡越堆越多。閒置時第一筆立刻送（不必等計時器），延遲最低。
//!   250ms 沒收到 ready（頁面還沒載好、被節流）就照送，避免卡死。
//! - **精簡格式**：代號第一次出現才送字串（id 表），之後每批只送平行的數字陣列
//!   `i`（id）`p`／`c`（分）`v`（量），高低有變才送稀疏的 `x:[k,hi,lo,…]`；
//!   JS 端不必為每筆報價建物件。
use std::collections::HashMap;
use std::fmt::Write as _;

use serde_json::{json, Value};

use crate::engine::{MinuteBar, Quote};

const NONE: u32 = u32::MAX;

#[derive(Default)]
pub struct PushBatch {
    // 持久的 id 表（跟網頁的 ENG_SYM／ENG_NAME 同步）
    ids: HashMap<String, u32>,
    syms: Vec<String>,
    names: Vec<String>,
    defined: Vec<bool>,
    name_dirty: Vec<bool>,
    pos: Vec<u32>,
    // 本批（平行陣列）
    bid: Vec<u32>,
    px: Vec<i32>,
    ch: Vec<i32>,
    vol: Vec<i64>,
    hi: Vec<i32>,
    lo: Vec<i32>,
    stamp0: Option<[u64; 3]>,
    stamp: Option<[u64; 3]>,
    raw: u64,
    nev: u64,
    intraday: Option<Value>,
    minutes: Vec<MinuteBar>,
    buf: String,
}

impl PushBatch {
    pub fn has_data(&self) -> bool {
        !self.bid.is_empty() || self.intraday.is_some() || !self.minutes.is_empty()
    }

    pub fn add_quotes(&mut self, quotes: Vec<Quote>, stamp: Option<[u64; 3]>) {
        self.add_quotes_ref(&quotes, stamp);
    }

    /// 借用版：XQ_WINDOWS 多視窗時同一包報價合併進每個視窗的批次（穩定狀態不配置；只有新代號／改名才複製字串）
    pub fn add_quotes_ref(&mut self, quotes: &[Quote], stamp: Option<[u64; 3]>) {
        self.raw += quotes.len() as u64;
        self.nev += 1;
        if let Some(st) = stamp {
            if self.stamp0.is_none() {
                self.stamp0 = Some(st);
            }
            self.stamp = Some(st);
        }
        for q in quotes {
            let id = match self.ids.get(q.symbol.as_str()) {
                Some(&id) => {
                    let i = id as usize;
                    if !q.name.is_empty() && self.names[i] != q.name {
                        self.names[i].clone_from(&q.name);
                        self.name_dirty[i] = true;
                    }
                    id
                }
                None => {
                    let id = self.syms.len() as u32;
                    self.ids.insert(q.symbol.clone(), id);
                    self.syms.push(q.symbol.clone());
                    self.names.push(q.name.clone());
                    self.defined.push(false);
                    self.name_dirty.push(false);
                    self.pos.push(NONE);
                    id
                }
            };
            let slot = self.pos[id as usize];
            if slot == NONE {
                self.pos[id as usize] = self.bid.len() as u32;
                self.bid.push(id);
                self.px.push(q.price);
                self.ch.push(q.change);
                self.vol.push(q.volume);
                self.hi.push(q.price);
                self.lo.push(q.price);
            } else {
                let k = slot as usize;
                self.px[k] = q.price;
                self.ch[k] = q.change;
                self.vol[k] = q.volume; // 當日累計量：最新值 = 已含中間每筆
                self.hi[k] = self.hi[k].max(q.price);
                self.lo[k] = self.lo[k].min(q.price);
            }
        }
    }

    pub fn add_intraday(&mut self, v: Value) {
        // 新快照覆蓋之前未送的分鐘線
        if let Some(sym) = v.get("symbol").and_then(|s| s.as_str()) {
            self.minutes.retain(|m| m.symbol != sym);
        }
        self.intraday = Some(v);
    }

    pub fn add_minutes(&mut self, bars: Vec<MinuteBar>) {
        for b in bars {
            // 只會有走勢圖那一檔，量很小，線性即可
            if let Some(m) = self.minutes.iter_mut().rev().find(|m| m.symbol == b.symbol && m.t == b.t) {
                m.h = m.h.max(b.h);
                m.l = m.l.min(b.l);
                m.c = b.c;
                m.v = b.v;
            } else {
                self.minutes.push(b);
            }
        }
    }

    /// 斷線：丟掉未送的行情（id 表保留，網頁那邊也還在）
    pub fn clear(&mut self) {
        for &id in &self.bid {
            self.pos[id as usize] = NONE;
        }
        self.bid.clear();
        self.px.clear();
        self.ch.clear();
        self.vol.clear();
        self.hi.clear();
        self.lo.clear();
        self.stamp0 = None;
        self.stamp = None;
        self.raw = 0;
        self.nev = 0;
        self.intraday = None;
        self.minutes.clear();
    }

    /// 網頁說它的 id 表不完整（例如頁面在第一批之前還沒載好）：之後重新定義用到的代號
    pub fn resync(&mut self) {
        self.defined.iter_mut().for_each(|d| *d = false);
    }

    /// 取出本批：回傳 (報價腳本, 分時／分鐘線腳本)。報價走 `__enginePushC`，其他沿用 `__enginePush`。
    pub fn take_scripts(&mut self, eval_us: Option<u64>) -> (Option<&str>, Option<String>) {
        let other = if self.intraday.is_some() || !self.minutes.is_empty() {
            let mut v = json!({});
            if let Some(intra) = self.intraday.take() {
                v["intraday"] = intra;
            }
            if !self.minutes.is_empty() {
                let px = |c: i32| c as f64 / 100.0;
                v["minutes"] = Value::Array(
                    self.minutes
                        .drain(..)
                        .map(|m| json!({ "symbol": m.symbol, "bar": [m.t, px(m.o), px(m.h), px(m.l), px(m.c), m.v] }))
                        .collect(),
                );
            }
            Some(format!("window.__enginePush&&window.__enginePush({v})"))
        } else {
            None
        };
        if self.bid.is_empty() {
            return (None, other);
        }
        let b = &mut self.buf;
        b.clear();
        b.push_str("window.__enginePushC&&window.__enginePushC({");
        // 新代號定義
        let mut first = true;
        for &id in &self.bid {
            let i = id as usize;
            if !self.defined[i] {
                b.push_str(if first { "d:[" } else { "," });
                first = false;
                let _ = write!(b, "{id},");
                push_js_str(b, &self.syms[i]);
                b.push(',');
                push_js_str(b, &self.names[i]);
                self.defined[i] = true;
                self.name_dirty[i] = false;
            }
        }
        if !first {
            b.push_str("],");
        }
        first = true;
        for &id in &self.bid {
            let i = id as usize;
            if self.name_dirty[i] {
                b.push_str(if first { "r:[" } else { "," });
                first = false;
                let _ = write!(b, "{id},");
                push_js_str(b, &self.names[i]);
                self.name_dirty[i] = false;
            }
        }
        if !first {
            b.push_str("],");
        }
        push_arr(b, "i", &self.bid);
        push_arr(b, "p", &self.px);
        push_arr(b, "c", &self.ch);
        push_arr(b, "v", &self.vol);
        first = true;
        for k in 0..self.bid.len() {
            if self.hi[k] != self.px[k] || self.lo[k] != self.px[k] {
                b.push_str(if first { "x:[" } else { "," });
                first = false;
                let _ = write!(b, "{k},{},{}", self.hi[k], self.lo[k]);
            }
        }
        if !first {
            b.push_str("],");
        }
        if let Some(s) = self.stamp0 {
            let _ = write!(b, "st0:[{},{},{}],", s[0], s[1], s[2]);
        }
        if let Some(s) = self.stamp {
            let _ = write!(b, "st:[{},{},{}],", s[0], s[1], s[2]);
        }
        if let Some(us) = eval_us {
            let _ = write!(b, "ev:{us},");
        }
        let _ = write!(b, "raw:{},nev:{}}})", self.raw, self.nev);
        // 清本批（保留容量，下一批不再配置）
        for &id in &self.bid {
            self.pos[id as usize] = NONE;
        }
        self.bid.clear();
        self.px.clear();
        self.ch.clear();
        self.vol.clear();
        self.hi.clear();
        self.lo.clear();
        self.stamp0 = None;
        self.stamp = None;
        self.raw = 0;
        self.nev = 0;
        (Some(self.buf.as_str()), other)
    }
}

fn push_arr<T: std::fmt::Display>(b: &mut String, key: &str, v: &[T]) {
    b.push_str(key);
    b.push_str(":[");
    for (k, x) in v.iter().enumerate() {
        if k > 0 {
            b.push(',');
        }
        let _ = write!(b, "{x}");
    }
    b.push_str("],");
}

fn push_js_str(b: &mut String, s: &str) {
    // JSON 字串也是合法 JS 字串（含 U+2028/2029 轉義：serde_json 不轉，這裡補）
    let j = serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
    b.push_str(&j.replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(s: &str, p: i32, v: i64) -> Quote {
        Quote { symbol: s.into(), name: format!("n{s}"), price: p, change: p - 100, volume: v }
    }

    #[test]
    fn coalesces_latest_and_keeps_extremes() {
        let mut b = PushBatch::default();
        b.add_quotes(vec![q("A", 100, 1), q("B", 50, 5), q("A", 120, 3)], Some([1, 10, 11]));
        b.add_quotes(vec![q("A", 90, 7)], Some([2, 20, 21]));
        let (js, other) = b.take_scripts(None);
        let js = js.unwrap().to_string();
        assert!(other.is_none());
        assert!(js.contains("d:[0,\"A\",\"nA\",1,\"B\",\"nB\"]"), "{js}");
        assert!(js.contains("i:[0,1],p:[90,50],c:[-10,-50],v:[7,5]"), "{js}");
        assert!(js.contains("x:[0,120,90]"), "{js}");
        assert!(js.contains("st0:[1,10,11],st:[2,20,21]"), "{js}");
        assert!(js.contains("raw:4,nev:2"), "{js}");
        // 第二批：已定義的代號不再送字串，位置索引已清空
        b.add_quotes(vec![q("B", 51, 6)], None);
        let js2 = b.take_scripts(None).0.unwrap().to_string();
        assert!(!js2.contains("d:["), "{js2}");
        assert!(js2.contains("i:[1],p:[51]"), "{js2}");
        assert!(!js2.contains("x:["), "{js2}");
        // resync 後重新定義
        b.resync();
        b.add_quotes(vec![q("A", 95, 8)], None);
        assert!(b.take_scripts(None).0.unwrap().contains("d:[0,\"A\""));
        assert!(b.take_scripts(None).0.is_none());
    }

    #[test]
    fn minutes_merge_by_symbol_and_minute() {
        let mut b = PushBatch::default();
        let m = |t, h, l, c, v| MinuteBar { symbol: "A".into(), t, o: 100, h, l, c, v };
        b.add_minutes(vec![m(1, 105, 99, 101, 10), m(1, 103, 97, 102, 12), m(2, 104, 101, 103, 3)]);
        let (_, other) = b.take_scripts(None);
        let o = other.unwrap();
        assert!(o.contains("[1,1.0,1.05,0.97,1.02,12]"), "{o}");
        assert!(o.contains("[2,1.0,1.04,1.01,1.03,3]"), "{o}");
    }

    #[test]
    fn borrowed_merge_matches_owned_merge() {
        // XQ_WINDOWS：其他視窗用 add_quotes_ref，送出的腳本要和主視窗完全一樣
        let mk = || vec![q("A", 100, 1), q("B", 50, 5), q("A", 120, 3), q("C", 70, 2)];
        let (mut a, mut b) = (PushBatch::default(), PushBatch::default());
        a.add_quotes(mk(), Some([1, 10, 11]));
        b.add_quotes_ref(&mk(), Some([1, 10, 11]));
        let mut renamed = q("B", 55, 6);
        renamed.name = "新名".into();
        a.add_quotes(vec![renamed], None);
        let mut renamed = q("B", 55, 6);
        renamed.name = "新名".into();
        b.add_quotes_ref(&[renamed], None);
        let (qa, oa) = a.take_scripts(Some(99));
        let (qa, oa) = (qa.map(str::to_string), oa);
        let (qb, ob) = b.take_scripts(Some(99));
        assert_eq!(qa.as_deref(), qb);
        assert_eq!(oa, ob);
    }
}
