// chart.js — XQ / TradingView 風格技術分析走勢圖（canvas，自己寫，不用任何外部函式庫）。
// 所有 K 線、成交量、分時資料都是依股票代號產生的「假」示範資料，每次結果相同。
// 由 Rust 在啟動時把這個檔案塞進 index.html（with_html 不能載入相對路徑檔案）。
// 畫線與指標設定存在 window.XQ_STATE，變動時用 ipc {type:"save"} 交給 Rust 寫成 JSON 檔。
(function () {
  "use strict";

  // ---------- 常數 ----------
  const C = {
    up: "#e5484d", down: "#30a46c", grid: "#242424", axis: "#8a8a8a", text: "#cfcfcf", sep: "#333",
    ma: ["#f5c542", "#c678dd", "#56b6c2"], ema: ["#ff7f50", "#7fdbff"],
    bb: "#5c9ded", sar: "#e0e0e0",
    k: "#f5a623", d: "#4fc3f7", dif: "#f5c542", dea: "#4fc3f7", rsi: "#c678dd", wr: "#f06292",
    pdi: "#e5484d", mdi: "#30a46c", adx: "#f5c542", atr: "#ffb74d", obv: "#4fc3f7", volma: ["#f5c542", "#c678dd"],
    cross: "#8b95a5", crossLabel: "#3b4252", draw: "#ffb000", sel: "#ffffff",
  };
  const PERIODS = [["T", "分時"], ["D", "日K"], ["W", "週K"], ["M", "月K"]];
  const DRAW_TOOLS = [["trend", "趨勢線"], ["ray", "射線"], ["hline", "水平線"], ["vline", "垂直線"],
    ["channel", "平行通道"], ["fib", "費波納契回撤"], ["rect", "矩形"], ["text", "文字註記"]];
  const NEED = { trend: 2, ray: 2, hline: 1, vline: 1, channel: 3, fib: 2, rect: 2, text: 1 };
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_COLORS = ["#9e9e9e", "#e5484d", "#f5a623", "#4caf50", "#26a69a", "#4fc3f7", "#9e9e9e"];
  const SUB_ORDER = ["vol", "kd", "macd", "rsi", "wr", "dmi", "atr", "obv"];
  const MAX_OVERLAYS = 20;   // 主圖疊加最多 20 組（同類型不同參數各自算一組）
  const MAX_SUBS = 10;       // 副圖最多 10 格（左欄+右欄）
  const SIDE_AXIS = 40;      // 左右副圖自己的刻度寬
  const OV_COLORS = ["#f5c542", "#c678dd", "#56b6c2", "#ff7f50", "#7fdbff", "#e5484d", "#30a46c",
    "#f06292", "#ffb74d", "#4fc3f7", "#aed581", "#ce93d8", "#80cbc4", "#ffab91", "#90caf9",
    "#fff176", "#ef9a9a", "#b0bec5", "#dce775", "#b39ddb"];
  // 主圖疊加類型：可新增多實例
  const OVERLAY_TYPES = {
    ma:  { label: "MA",  defaults: { period: 20 }, params: [["period", "週期"]] },
    ema: { label: "EMA", defaults: { period: 12 }, params: [["period", "週期"]] },
    bb:  { label: "布林", defaults: { n: 20, k: 2 }, params: [["n", "週期"], ["k", "倍數", true]] },
    sar: { label: "SAR", defaults: { step: 0.02, max: 0.2 }, params: [["step", "加速", true], ["max", "上限", true]] },
  };
  // 副圖仍用 cfg.*.on；主圖改走 overlays[]（見 ensureOverlays）
  const DEFAULT_CFG = {
    ma: { on: true, p1: 5, p2: 20, p3: 60 },
    ema: { on: false, p1: 12, p2: 26 },
    bb: { on: false, n: 20, k: 2 },
    sar: { on: false, step: 0.02, max: 0.2 },
    vol: { on: true },
    volma: { on: true, p1: 5, p2: 20 },
    kd: { on: false, n: 9, k: 3, d: 3 },
    macd: { on: false, fast: 12, slow: 26, sig: 9 },
    rsi: { on: false, n: 14 },
    wr: { on: false, n: 14 },
    dmi: { on: false, n: 14 },
    atr: { on: false, n: 14 },
    obv: { on: false },
  };
  const IND_DEFS = [
    ["vol", "sub", "成交量", []],
    ["volma", "sub", "成交量均線", [["p1", "週期"], ["p2", ""]]],
    ["kd", "sub", "KD 隨機指標", [["n", "週期"], ["k", "K"], ["d", "D"]]],
    ["macd", "sub", "MACD", [["fast", "快"], ["slow", "慢"], ["sig", "訊號"]]],
    ["rsi", "sub", "RSI", [["n", "週期"]]],
    ["wr", "sub", "威廉指標 %R", [["n", "週期"]]],
    ["dmi", "sub", "DMI / ADX", [["n", "週期"]]],
    ["atr", "sub", "ATR 真實波幅", [["n", "週期"]]],
    ["obv", "sub", "OBV 能量潮", []],
  ];
  function defaultOverlays() {
    return [
      { type: "ma", period: 5 }, { type: "ma", period: 20 }, { type: "ma", period: 60 },
    ];
  }
  function ensureOverlays(entry) {
    if (Array.isArray(entry.overlays) && entry.overlays.length) {
      entry.overlays = entry.overlays.filter(o => o && OVERLAY_TYPES[o.type]).slice(0, MAX_OVERLAYS);
      for (const o of entry.overlays) {
        const d = OVERLAY_TYPES[o.type].defaults;
        for (const k of Object.keys(d)) if (o[k] === undefined) o[k] = d[k];
      }
      return;
    }
    // 從舊版 cfg.ma/ema/bb/sar 遷移
    const o = [], c = entry.cfg || {};
    if (!c.ma || c.ma.on !== false) {
      o.push({ type: "ma", period: (c.ma && c.ma.p1) || 5 });
      o.push({ type: "ma", period: (c.ma && c.ma.p2) || 20 });
      o.push({ type: "ma", period: (c.ma && c.ma.p3) || 60 });
    }
    if (c.ema && c.ema.on) {
      o.push({ type: "ema", period: c.ema.p1 || 12 });
      o.push({ type: "ema", period: c.ema.p2 || 26 });
    }
    if (c.bb && c.bb.on) o.push({ type: "bb", n: c.bb.n || 20, k: c.bb.k || 2 });
    if (c.sar && c.sar.on) o.push({ type: "sar", step: c.sar.step || 0.02, max: c.sar.max || 0.2 });
    entry.overlays = o.length ? o.slice(0, MAX_OVERLAYS) : defaultOverlays();
  }
  function ensureSubLayout() {
    const sl = store.ui.subLayout && typeof store.ui.subLayout === "object" ? store.ui.subLayout : {};
    let left = Math.max(0, Math.min(MAX_SUBS, Math.round(+sl.left || 0)));
    let right = Math.max(0, Math.min(MAX_SUBS, Math.round(+sl.right || 0)));
    if (left + right > MAX_SUBS) right = MAX_SUBS - left;
    // 預設：有副圖時左右均分（成交量偏左）
    if (!store.ui.subLayout) { left = 1; right = 3; }
    store.ui.subLayout = { left, right };
    return store.ui.subLayout;
  }
  const N_DAILY = 1200;
  const AXIS_W = 66, TIME_H = 18, PLOT_L = 4;

  const clone = o => JSON.parse(JSON.stringify(o));
  function mergeCfg(saved) {
    const out = clone(DEFAULT_CFG);
    if (saved && typeof saved === "object") for (const id in out) if (saved[id]) Object.assign(out[id], saved[id]);
    return out;
  }

  // ---------- 假資料 ----------
  function rng(text, salt) {
    let s = (2166136261 ^ salt) >>> 0;
    for (const ch of text) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  }
  const gauss = r => (r() + r() + r() + r() - 2) * 1.732;
  const round2 = v => Math.round(v * 100) / 100;

  function tradingDays(n) {
    const out = [], d = new Date();
    d.setHours(12, 0, 0, 0);
    while (out.length < n) {
      const wd = d.getDay();
      if (wd !== 0 && wd !== 6) out.push(new Date(d));
      d.setDate(d.getDate() - 1);
    }
    return out.reverse();
  }

  function genDaily(q) {
    const r = rng(q.symbol, 11);
    const dates = tradingDays(N_DAILY);
    const baseVol = 3000 + r() * 30000, drift = (r() - 0.35) * 0.0012;
    const bars = [];
    let prev = 100;
    for (let i = 0; i < N_DAILY; i++) {
      const o = prev * (1 + gauss(r) * 0.004);
      const c = prev * (1 + drift + gauss(r) * 0.016);
      const h = Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.005);
      const l = Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.005);
      bars.push({ t: dates[i], o, h, l, c, v: baseVol * (0.5 + r()) * (1 + 12 * Math.abs(c / prev - 1)) });
      prev = c;
    }
    const prevClose = q.price - q.change, f = prevClose / bars[N_DAILY - 2].c;
    for (const b of bars) { b.o = round2(b.o * f); b.h = round2(b.h * f); b.l = round2(b.l * f); b.c = round2(b.c * f); b.v = Math.round(b.v); }
    const last = bars[N_DAILY - 1];
    last.o = round2(prevClose * (1 + gauss(r) * 0.002));
    last.c = q.price;
    last.h = round2(Math.max(last.o, last.c) * (1 + r() * 0.004));
    last.l = round2(Math.min(last.o, last.c) * (1 - r() * 0.004));
    return bars;
  }

  function aggregate(daily, keyOf) {
    const out = [];
    let cur = null, curKey = null;
    for (const b of daily) {
      const k = keyOf(b.t);
      if (k !== curKey) { cur = { ...b }; curKey = k; out.push(cur); }
      else { cur.t = b.t; cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
    }
    return out;
  }
  const weekKey = d => { const m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m.toDateString(); };
  const monthKey = d => d.getFullYear() * 100 + d.getMonth();

  function genIntraday(q, prevClose) {
    const r = rng(q.symbol, 29), n = 271, bars = [];
    let p = prevClose;
    for (let i = 0; i < n; i++) {
      const target = prevClose + (q.change * i) / (n - 1), o = p;
      p += (target - p) * 0.12 + gauss(r) * prevClose * 0.0012;
      if (i === n - 1) p = q.price;
      const h = Math.max(o, p) + Math.abs(gauss(r)) * prevClose * 0.0005;
      const l = Math.min(o, p) - Math.abs(gauss(r)) * prevClose * 0.0005;
      const u = Math.abs(i - n / 2) / (n / 2);
      bars.push({ t: 540 + i, o: round2(o), h: round2(h), l: round2(l), c: round2(p), v: Math.round((40 + 400 * u * u) * (0.4 + r() * 1.2)) });
    }
    return bars;
  }

  // ---------- 指標計算 ----------
  const nanArr = n => new Array(n).fill(NaN);
  function sma(src, n) {
    const out = nanArr(src.length);
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i];
      if (i >= n) sum -= src[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  function ema(src, n) {
    const a = 2 / (n + 1), out = [];
    src.forEach((v, i) => out.push(i ? out[i - 1] + a * (v - out[i - 1]) : v));
    return out;
  }
  const trueRange = (b, i) => i ? Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)) : b[i].h - b[i].l;
  function highLow(bars, i, n) {
    let hi = -Infinity, lo = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
    return [hi, lo];
  }
  const CALC = {
    ma: (b, p) => { const c = b.map(x => x.c); return { a: sma(c, p.p1), b: sma(c, p.p2), c: sma(c, p.p3) }; },
    ema: (b, p) => { const c = b.map(x => x.c); return { a: ema(c, p.p1), b: ema(c, p.p2) }; },
    bb: (b, p) => {
      const c = b.map(x => x.c), mid = sma(c, p.n), up = nanArr(c.length), lo = nanArr(c.length);
      for (let i = p.n - 1; i < c.length; i++) {
        let s = 0;
        for (let j = i - p.n + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
        const sd = Math.sqrt(s / p.n);
        up[i] = mid[i] + p.k * sd; lo[i] = mid[i] - p.k * sd;
      }
      return { mid, up, lo };
    },
    sar: (b, p) => {
      const n = b.length, out = nanArr(n), up = new Array(n).fill(true);
      if (n < 3) return { sar: out, up };
      let isUp = b[1].c >= b[0].c, af = p.step, ep = isUp ? b[0].h : b[0].l, s = isUp ? b[0].l : b[0].h;
      for (let i = 1; i < n; i++) {
        s += af * (ep - s);
        if (isUp) {
          s = Math.min(s, b[i - 1].l, b[Math.max(0, i - 2)].l);
          if (b[i].l < s) { isUp = false; s = ep; ep = b[i].l; af = p.step; }
          else if (b[i].h > ep) { ep = b[i].h; af = Math.min(p.max, af + p.step); }
        } else {
          s = Math.max(s, b[i - 1].h, b[Math.max(0, i - 2)].h);
          if (b[i].h > s) { isUp = true; s = ep; ep = b[i].h; af = p.step; }
          else if (b[i].l < ep) { ep = b[i].l; af = Math.min(p.max, af + p.step); }
        }
        out[i] = s; up[i] = isUp;
      }
      return { sar: out, up };
    },
    volma: (b, p) => { const v = b.map(x => x.v); return { a: sma(v, p.p1), b: sma(v, p.p2) }; },
    kd: (b, p) => {
      const k = [], d = [];
      let pk = 50, pd = 50;
      for (let i = 0; i < b.length; i++) {
        const [hi, lo] = highLow(b, i, p.n);
        const rsv = hi > lo ? ((b[i].c - lo) / (hi - lo)) * 100 : 50;
        pk = ((p.k - 1) * pk + rsv) / p.k; pd = ((p.d - 1) * pd + pk) / p.d;
        k.push(i >= p.n - 1 ? pk : NaN); d.push(i >= p.n - 1 ? pd : NaN);
      }
      return { k, d };
    },
    macd: (b, p) => {
      const c = b.map(x => x.c), f = ema(c, p.fast), s = ema(c, p.slow);
      const dif = c.map((_, i) => f[i] - s[i]), dea = ema(dif, p.sig);
      return { dif, dea, osc: dif.map((v, i) => v - dea[i]) };
    },
    rsi: (b, p) => {
      const c = b.map(x => x.c), out = nanArr(c.length), n = p.n;
      let ag = 0, al = 0;
      for (let i = 1; i < c.length; i++) {
        const ch = c[i] - c[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
        if (i <= n) { ag += g / n; al += l / n; } else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; }
        if (i >= n) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
      return { rsi: out };
    },
    wr: (b, p) => ({ wr: b.map((x, i) => { if (i < p.n - 1) return NaN; const [hi, lo] = highLow(b, i, p.n); return hi > lo ? ((hi - x.c) / (hi - lo)) * -100 : -50; }) }),
    dmi: (b, p) => {
      const len = b.length, n = p.n, pdi = nanArr(len), mdi = nanArr(len), adx = nanArr(len);
      let trS = 0, pS = 0, mS = 0, adxV = NaN, dxSum = 0, dxCount = 0;
      for (let i = 1; i < len; i++) {
        const upM = b[i].h - b[i - 1].h, dnM = b[i - 1].l - b[i].l;
        const pdm = upM > dnM && upM > 0 ? upM : 0, mdm = dnM > upM && dnM > 0 ? dnM : 0, tr = trueRange(b, i);
        if (i <= n) { trS += tr; pS += pdm; mS += mdm; } else { trS += tr - trS / n; pS += pdm - pS / n; mS += mdm - mS / n; }
        if (i >= n && trS > 0) {
          const pp = (100 * pS) / trS, mm = (100 * mS) / trS;
          pdi[i] = pp; mdi[i] = mm;
          const dx = pp + mm ? (100 * Math.abs(pp - mm)) / (pp + mm) : 0;
          if (dxCount < n) { dxSum += dx; if (++dxCount === n) adxV = dxSum / n; } else adxV = (adxV * (n - 1) + dx) / n;
          if (dxCount >= n) adx[i] = adxV;
        }
      }
      return { pdi, mdi, adx };
    },
    atr: (b, p) => {
      const out = nanArr(b.length);
      let s = 0;
      for (let i = 0; i < b.length; i++) {
        const tr = trueRange(b, i);
        if (i < p.n) { s += tr; if (i === p.n - 1) out[i] = s / p.n; } else out[i] = (out[i - 1] * (p.n - 1) + tr) / p.n;
      }
      return { atr: out };
    },
    obv: b => { const out = []; let v = 0; b.forEach((x, i) => { if (i) v += x.c > b[i - 1].c ? x.v : x.c < b[i - 1].c ? -x.v : 0; out.push(v); }); return { obv: out }; },
  };

  // ---------- 格式 ----------
  const pad2 = n => String(n).padStart(2, "0");
  function fmtTime(t, period, long) {
    if (period === "T") return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
    const y = t.getFullYear(), m = pad2(t.getMonth() + 1), d = pad2(t.getDate());
    if (period === "M") return `${y}/${m}`;
    return long || period === "W" ? `${y}/${m}/${d}` : `${m}/${d}`;
  }
  const fmtP = v => (Number.isFinite(v) ? v.toFixed(2) : "--");
  const fmtV = v => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "--");
  const fmtAuto = v => (!Number.isFinite(v) ? "--" : Math.abs(v) >= 10000 ? fmtV(v) : v.toFixed(2));
  function niceStep(range, count) {
    const raw = range / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }

  // ---------- 持久化 ----------
  const store = window.XQ_STATE && typeof window.XQ_STATE === "object" ? window.XQ_STATE : {};
  store.v = 1;
  store.keys = store.keys && typeof store.keys === "object" ? store.keys : {};
  store.ui = store.ui && typeof store.ui === "object" ? store.ui : {};
  ensureSubLayout();
  let saveTimer = 0;
  function save() {
    if (window.XQ_PERF) return; // 效能測試不要寫 state
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify({ type: "save", data: store }));
    }, 450);
  }

  // ---------- 圖表 ----------
  function create(canvas, toolbar) {
    const g = canvas.getContext("2d");
    const host = toolbar.parentElement;       // #top（選單掛在這裡）
    const wrap = canvas.parentElement;        // #chart-wrap（文字輸入框掛在這裡）
    const cache = {}, views = {};
    let tabId = "chart-1", quote = null;
    let period = PERIODS.some(p => p[0] === store.ui.period) ? store.ui.period : "D";
    let entry = null;                         // { cfg, drawings } of current tab|symbol|period
    let lastCfg = null, metaCb = null;
    let tool = "cursor", drawTool = "trend", selected = -1;
    let mouse = null, pan = null, pending = null, drag = null, layout = null;
    let cssW = 0, cssH = 0;
    // ---------- 繪圖層快取 + 空間索引（效能）----------
    const drawLayer = document.createElement("canvas");
    const drawG = drawLayer.getContext("2d");
    let drawLayerDirty = true;
    let spatialDirty = true;
    let drawViewKey = "";
    let drawGen = 0;
    let spatial = { cell: 64, cols: 0, rows: 0, buckets: [], geoms: [] };
    function markDrawingsDirty() { drawLayerDirty = true; spatialDirty = true; drawGen++; }
    function layoutFingerprint(L, v) {
      const pr = L && L.panes && L.panes[0];
      return [
        cssW, cssH, period, selected, drawGen,
        v && v.right, v && v.barW,
        L && L.plotL, L && L.plotR,
        pr && pr.lo, pr && pr.hi, pr && pr.top, pr && pr.h, pr && pr.y0, pr && pr.ph,
      ].join("|");
    }

    // 每個分頁獨立：tabId|symbol|period（舊的 symbol|period 仍可讀，新寫入用完整鍵）
    const key = () => `${tabId}|${quote.symbol}|${period}`;
    function loadEntry() {
      const k = key(), legacy = `${quote.symbol}|${period}`;
      if (!store.keys[k]) {
        if (store.keys[legacy]) store.keys[k] = clone(store.keys[legacy]);
        else store.keys[k] = { cfg: clone(lastCfg || DEFAULT_CFG), drawings: [] };
      }
      entry = store.keys[k];
      entry.cfg = mergeCfg(entry.cfg);
      ensureOverlays(entry);
      if (!Array.isArray(entry.drawings)) entry.drawings = [];
      entry.drawings = entry.drawings.filter(d => d && NEED[d.type] && Array.isArray(d.pts));
      lastCfg = entry.cfg;
      selected = -1; pending = null; drag = null;
      markDrawingsDirty();
    }
    const cfg = () => entry.cfg;
    const drawings = () => entry.drawings;

    function series() {
      const k = key();
      if (!cache[k]) {
        const dk = `${quote.symbol}|D`;
        if (!cache[dk]) cache[dk] = { bars: genDaily(quote), memo: {} };
        const daily = cache[dk].bars;
        if (!cache[k]) {
          let bars = daily;
          if (period === "W") bars = aggregate(daily, weekKey);
          if (period === "M") bars = aggregate(daily, monthKey);
          if (period === "T") bars = genIntraday(quote, daily[daily.length - 2].c);
          cache[k] = { bars, memo: {} };
        }
      }
      return cache[k];
    }
    function ind(id) {
      const s = series(), p = cfg()[id], mk = id + JSON.stringify(p);
      return s.memo[mk] || (s.memo[mk] = CALC[id](s.bars, p));
    }
    function view() {
      const k = key();
      if (!views[k]) {
        const n = series().bars.length, plotW = Math.max(100, cssW - AXIS_W - PLOT_L);
        views[k] = period === "T" ? { barW: plotW / n, right: n - 1 }
          : { barW: n * 8 < plotW ? plotW / (n + 3) : 8, right: n - 1 + 2 };
      }
      return views[k];
    }
    function clampView(v, n) {
      const plotW = Math.max(50, cssW - AXIS_W - PLOT_L);
      v.barW = Math.max(Math.min(2, plotW / n), Math.min(60, v.barW));
      const visible = plotW / v.barW;
      v.right = Math.max(Math.min(n - 1, visible * 0.2), Math.min(n - 1 + visible * 0.5, v.right));
    }

    // ---------- 工具列與選單 ----------
    const btn = {};
    function mkBtn(parent, id, label, onClick, cls = "") {
      const b = document.createElement("button");
      b.textContent = label; b.className = cls;
      b.addEventListener("click", e => { e.stopPropagation(); onClick(b); });
      btn[id] = b; parent.appendChild(b);
      return b;
    }
    function mkGroup() { const gEl = document.createElement("div"); gEl.className = "tb-group"; toolbar.appendChild(gEl); return gEl; }

    let gp = mkGroup();
    for (const [id, label] of PERIODS) mkBtn(gp, "period:" + id, label, () => setPeriod(id));
    gp = mkGroup();
    mkBtn(gp, "ind", "指標 ▾", b => toggleMenu(indMenu, b));
    gp = mkGroup();
    mkBtn(gp, "cursor", "游標", () => { tool = "cursor"; pending = null; closeMenus(); sync(); render(); });
    mkBtn(gp, "draw", "畫線 ▾", b => toggleMenu(drawMenu, b));
    gp = mkGroup();
    mkBtn(gp, "delete", "刪除", () => { deleteSelected(); render(); });
    mkBtn(gp, "clear", "全部清除", () => { drawings().length = 0; selected = -1; save(); markDrawingsDirty(); sync(); render(); });
    mkBtn(gp, "reset", "重設縮放", () => { delete views[key()]; render(); });

    function makeMenu(cls) {
      const m = document.createElement("div");
      m.className = "tb-menu " + cls; m.hidden = true;
      m.addEventListener("mousedown", e => e.stopPropagation());
      host.appendChild(m);
      return m;
    }
    const indMenu = makeMenu("ind-menu");
    const drawMenu = makeMenu("draw-menu");
    for (const [id, label] of DRAW_TOOLS) {
      const b = document.createElement("button");
      b.className = "menu-item"; b.textContent = label; b.dataset.id = id;
      b.addEventListener("click", () => { drawTool = id; tool = "draw"; pending = null; closeMenus(); sync(); render(); });
      drawMenu.appendChild(b);
    }
    function buildIndMenu() {
      indMenu.innerHTML = "";
      ensureOverlays(entry);
      const sl = ensureSubLayout();

      // ---- 主圖疊加（最多 20）----
      const h1 = document.createElement("div"); h1.className = "menu-title";
      h1.textContent = `主圖疊加（${entry.overlays.length}/${MAX_OVERLAYS}）`; indMenu.appendChild(h1);
      const addRow = document.createElement("div"); addRow.className = "ind-row"; addRow.style.gap = "4px";
      for (const [type, meta] of Object.entries(OVERLAY_TYPES)) {
        const b = document.createElement("button"); b.type = "button"; b.className = "menu-item";
        b.textContent = "+ " + meta.label; b.style.height = "22px"; b.style.padding = "0 6px";
        b.disabled = entry.overlays.length >= MAX_OVERLAYS;
        b.addEventListener("click", () => {
          if (entry.overlays.length >= MAX_OVERLAYS) return;
          entry.overlays.push({ type, ...clone(meta.defaults) });
          buildIndMenu(); changed();
        });
        addRow.appendChild(b);
      }
      indMenu.appendChild(addRow);
      entry.overlays.forEach((ov, idx) => {
        const meta = OVERLAY_TYPES[ov.type];
        const row = document.createElement("div"); row.className = "ind-row";
        const lab = document.createElement("span"); lab.className = "ind-name";
        lab.style.color = OV_COLORS[idx % OV_COLORS.length];
        lab.textContent = `${idx + 1}. ${meta.label}`;
        row.appendChild(lab);
        for (const [pk, pl, isFloat] of meta.params) {
          if (pl) { const sEl = document.createElement("span"); sEl.className = "ind-pl"; sEl.textContent = pl; row.appendChild(sEl); }
          const inp = document.createElement("input");
          inp.type = "number"; inp.value = ov[pk]; inp.step = isFloat ? "0.01" : "1"; inp.min = isFloat ? "0.01" : "1";
          inp.addEventListener("change", () => {
            let v = parseFloat(inp.value);
            if (!Number.isFinite(v) || v <= 0) v = meta.defaults[pk];
            v = isFloat ? Math.min(10, v) : Math.max(1, Math.min(500, Math.round(v)));
            inp.value = v; ov[pk] = v; changed();
          });
          row.appendChild(inp);
        }
        const del = document.createElement("button"); del.type = "button"; del.textContent = "×";
        del.title = "移除"; del.style.cssText = "background:#333;color:#ccc;border:1px solid #555;border-radius:3px;width:22px;height:22px;cursor:pointer;";
        del.addEventListener("click", () => { entry.overlays.splice(idx, 1); buildIndMenu(); changed(); });
        row.appendChild(del);
        indMenu.appendChild(row);
      });

      // ---- 副圖版面（左/右，合計 ≤10）----
      const h2 = document.createElement("div"); h2.className = "menu-title";
      h2.textContent = `副圖版面（左+右 ≤ ${MAX_SUBS}，主圖置中）`; indMenu.appendChild(h2);
      const lay = document.createElement("div"); lay.className = "ind-row";
      const mkNum = (label, key) => {
        const sp = document.createElement("span"); sp.className = "ind-pl"; sp.textContent = label; lay.appendChild(sp);
        const inp = document.createElement("input"); inp.type = "number"; inp.min = "0"; inp.max = String(MAX_SUBS);
        inp.value = sl[key]; inp.style.width = "44px";
        inp.addEventListener("change", () => {
          let v = Math.round(+inp.value); if (!Number.isFinite(v) || v < 0) v = 0;
          v = Math.min(MAX_SUBS, v);
          const other = key === "left" ? "right" : "left";
          if (v + sl[other] > MAX_SUBS) sl[other] = MAX_SUBS - v;
          sl[key] = v; store.ui.subLayout = { left: sl.left, right: sl.right };
          buildIndMenu(); changed();
        });
        lay.appendChild(inp);
      };
      mkNum("左欄", "left"); mkNum("右欄", "right");
      const sum = document.createElement("span"); sum.className = "ind-pl";
      sum.textContent = `合計 ${sl.left + sl.right}`; lay.appendChild(sum);
      indMenu.appendChild(lay);

      // ---- 副圖開關 ----
      const h3 = document.createElement("div"); h3.className = "menu-title";
      h3.textContent = "副圖指標（依順序填入左欄再右欄）"; indMenu.appendChild(h3);
      for (const [id, g2, label, params] of IND_DEFS) {
        const row = document.createElement("div"); row.className = "ind-row";
        const lab = document.createElement("label"); lab.className = "ind-name";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!cfg()[id].on;
        cb.addEventListener("change", () => { cfg()[id].on = cb.checked; changed(); });
        lab.append(cb, document.createTextNode(" " + label));
        row.append(lab);
        for (const [pk, pl, isFloat] of params) {
          if (pl) { const sEl = document.createElement("span"); sEl.className = "ind-pl"; sEl.textContent = pl; row.appendChild(sEl); }
          const inp = document.createElement("input");
          inp.type = "number"; inp.value = cfg()[id][pk]; inp.step = isFloat ? "0.01" : "1"; inp.min = isFloat ? "0.01" : "1";
          inp.addEventListener("change", () => {
            let v = parseFloat(inp.value);
            if (!Number.isFinite(v) || v <= 0) v = DEFAULT_CFG[id][pk];
            v = isFloat ? Math.min(10, v) : Math.max(1, Math.min(500, Math.round(v)));
            inp.value = v; cfg()[id][pk] = v; changed();
          });
          row.appendChild(inp);
        }
        indMenu.appendChild(row);
      }
      const reset = document.createElement("button");
      reset.className = "menu-item"; reset.textContent = "恢復預設指標";
      reset.addEventListener("click", () => {
        entry.cfg = clone(DEFAULT_CFG); entry.overlays = defaultOverlays();
        store.ui.subLayout = { left: 1, right: 3 };
        lastCfg = entry.cfg; buildIndMenu(); changed();
      });
      indMenu.appendChild(reset);
    }
    function changed() { save(); render(); }
    function toggleMenu(menu, anchor) {
      const open = menu.hidden;
      closeMenus();
      if (!open) return;
      if (menu === indMenu) buildIndMenu();
      const hr = host.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
      menu.hidden = false;
      const left = Math.max(2, Math.min(ar.left - hr.left, hr.width - menu.offsetWidth - 4));
      menu.style.left = left + "px";
      menu.style.top = ar.bottom - hr.top + 2 + "px";
      menu.style.maxHeight = Math.max(80, hr.bottom - ar.bottom - 8) + "px"; // 不超出上方走勢圖格（避免被右下網頁蓋住）
    }
    function closeMenus() { indMenu.hidden = true; drawMenu.hidden = true; }
    document.addEventListener("mousedown", () => closeMenus());

    function sync() {
      for (const [id] of PERIODS) btn["period:" + id].classList.toggle("on", id === period);
      btn.cursor.classList.toggle("on", tool === "cursor");
      const dname = DRAW_TOOLS.find(t => t[0] === drawTool)[1];
      const dl = tool === "draw" ? `畫線：${dname} ▾` : "畫線 ▾";
      if (btn.draw.textContent !== dl) btn.draw.textContent = dl; // 不要無謂地換掉文字節點：WebKit 會因此吞掉按鈕的 click
      btn.draw.classList.toggle("on", tool === "draw");
      for (const b of drawMenu.children) b.classList.toggle("on", b.dataset.id === drawTool);
      btn.delete.disabled = selected < 0;
      btn.clear.disabled = !entry || drawings().length === 0;
      canvas.style.cursor = pan ? "grabbing" : drag ? "move" : "crosshair";
    }
    function setPeriod(id) {
      period = id; store.ui.period = id; save();
      if (quote) loadEntry();
      if (metaCb) metaCb({ tabId, symbol: quote && quote.symbol, period });
      closeMenus(); sync(); render();
    }
    function deleteSelected() {
      if (selected >= 0) { drawings().splice(selected, 1); selected = -1; save(); markDrawingsDirty(); }
      sync();
    }

    // ---------- 重繪 ----------
    let queued = false;
    function requestRender() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        if (!queued) return;
        queued = false;
        render();
      });
    }
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      cssW = canvas.clientWidth; cssH = canvas.clientHeight;
      const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      markDrawingsDirty();
      render();
    }

    function overlayCalc(ov) {
      const s = series(), mk = "ov:" + ov.type + JSON.stringify(ov);
      if (s.memo[mk]) return s.memo[mk];
      let out = {};
      try {
        if (ov.type === "ma") out = { line: CALC.ma(s.bars, { p1: +ov.period || 20, p2: +ov.period || 20, p3: +ov.period || 20 }).a };
        else if (ov.type === "ema") out = { line: CALC.ema(s.bars, { p1: +ov.period || 12, p2: +ov.period || 12 }).a };
        else if (ov.type === "bb") out = CALC.bb(s.bars, { n: +ov.n || 20, k: +ov.k || 2 });
        else if (ov.type === "sar") out = CALC.sar(s.bars, { step: +ov.step || 0.02, max: +ov.max || 0.2 });
      } catch (e) { out = {}; }
      return (s.memo[mk] = out);
    }
    function overlayLegend(i) {
      const items = [];
      (entry.overlays || []).forEach((ov, idx) => {
        const col = OV_COLORS[idx % OV_COLORS.length], m = overlayCalc(ov);
        if (ov.type === "ma" || ov.type === "ema") items.push([`${ov.type.toUpperCase()}${ov.period} ${fmtP(m.line[i])}`, col]);
        else if (ov.type === "bb") items.push([`BB(${ov.n},${ov.k}) ${fmtP(m.mid[i])}`, col], [`上 ${fmtP(m.up[i])}`, col], [`下 ${fmtP(m.lo[i])}`, col]);
        else if (ov.type === "sar") items.push([`SAR ${fmtP(m.sar[i])}`, col]);
      });
      return items;
    }
    function wrapItems(items, width) {
      const lines = [[]];
      let x = 0;
      for (const it of items) {
        const w = g.measureText(it[0]).width + 10;
        if (x + w > width && lines[lines.length - 1].length) { lines.push([]); x = 0; }
        lines[lines.length - 1].push(it); x += w;
      }
      return items.length ? lines : [];
    }

    function subSpec(id, i0, i1, bars) {
      const c = cfg();
      switch (id) {
        case "vol": {
          const lines = [];
          if (c.volma.on) { const m = ind("volma"); lines.push([m.a, C.volma[0], `MA${c.volma.p1}`], [m.b, C.volma[1], `MA${c.volma.p2}`]); }
          return { title: "成交量", vol: true, lines, lo: 0 };
        }
        case "kd": { const m = ind("kd"); return { title: `KD(${c.kd.n},${c.kd.k},${c.kd.d})`, lines: [[m.k, C.k, "K"], [m.d, C.d, "D"]], fixed: [0, 100], guides: [20, 50, 80] }; }
        case "macd": { const m = ind("macd"); return { title: `MACD(${c.macd.fast},${c.macd.slow},${c.macd.sig})`, hist: m.osc, histName: "OSC", lines: [[m.dif, C.dif, "DIF"], [m.dea, C.dea, "MACD"]], sym: true }; }
        case "rsi": { const m = ind("rsi"); return { title: `RSI(${c.rsi.n})`, lines: [[m.rsi, C.rsi, ""]], fixed: [0, 100], guides: [30, 50, 70] }; }
        case "wr": { const m = ind("wr"); return { title: `%R(${c.wr.n})`, lines: [[m.wr, C.wr, ""]], fixed: [-100, 0], guides: [-80, -50, -20] }; }
        case "dmi": { const m = ind("dmi"); return { title: `DMI(${c.dmi.n})`, lines: [[m.pdi, C.pdi, "+DI"], [m.mdi, C.mdi, "-DI"], [m.adx, C.adx, "ADX"]], lo: 0, guides: [20] }; }
        case "atr": { const m = ind("atr"); return { title: `ATR(${c.atr.n})`, lines: [[m.atr, C.atr, ""]] }; }
        case "obv": { const m = ind("obv"); return { title: "OBV", lines: [[m.obv, C.obv, ""]] }; }
      }
      return null;
    }

    // ---------- 主繪圖 ----------
    function render() {
      if (!quote || !entry || cssW < 50 || cssH < 50) return;
      const dpr = window.devicePixelRatio || 1;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cssW, cssH);
      g.font = "11px sans-serif";
      g.textBaseline = "middle";

      const { bars } = series(), n = bars.length, v = view(), c = cfg();
      const sl = ensureSubLayout();
      const enabledSubs = SUB_ORDER.filter(id => c[id] && c[id].on);
      const leftN = Math.min(sl.left, enabledSubs.length);
      const rightN = Math.min(sl.right, Math.max(0, enabledSubs.length - leftN));
      const leftIds = enabledSubs.slice(0, leftN);
      const rightIds = enabledSubs.slice(leftN, leftN + rightN);

      // 主圖置中，左右欄堆疊副圖
      let leftColW = leftIds.length ? Math.max(110, Math.min(Math.floor(cssW * 0.2), Math.floor(cssW * 0.22))) : 0;
      let rightColW = rightIds.length ? Math.max(110, Math.min(Math.floor(cssW * 0.2), Math.floor(cssW * 0.22))) : 0;
      if (leftColW + rightColW > cssW * 0.55) {
        const scale = (cssW * 0.55) / (leftColW + rightColW);
        leftColW = Math.floor(leftColW * scale); rightColW = Math.floor(rightColW * scale);
      }
      const pricePlotL = leftColW + (leftColW ? 2 : 0) + PLOT_L;
      const pricePlotR = cssW - rightColW - (rightColW ? 2 : 0) - AXIS_W;
      const plotL = pricePlotL, plotR = Math.max(pricePlotL + 80, pricePlotR), plotW = plotR - plotL;
      clampView(v, n);
      const xOf = i => plotR - (v.right - i) * v.barW - v.barW / 2;
      const idxAt = x => v.right - (plotR - v.barW / 2 - x) / v.barW;
      const mkXOf = (pL, pR) => {
        const w = pR - pL, scale = w / Math.max(1, plotW);
        return i => pR - (v.right - i) * v.barW * scale - (v.barW * scale) / 2;
      };
      const i0 = Math.max(0, Math.floor(idxAt(plotL))), i1 = Math.min(n - 1, Math.ceil(idxAt(plotR)));

      const avail = Math.max(60, cssH - TIME_H);
      // 圖例行數粗估（稍後用真實 infoIdx 重算內容）；最多預留 6 行
      const priceHdr = 16 + 14 * Math.min(6, Math.max(1, Math.ceil(((entry.overlays || []).length + 1) / 4)));
      const panes = [];
      // 價格主圖：置中、佔滿可用高度
      const pricePane = { id: "price", side: "center", top: 0, h: avail, hdr: priceHdr, plotL, plotR, axisX: plotR };
      panes.push(pricePane);
      const stack = (ids, side, colL, colR, axisX) => {
        if (!ids.length) return;
        const each = avail / ids.length;
        ids.forEach((id, k) => {
          panes.push({
            id, side, top: k * each, h: each, hdr: 13,
            plotL: colL, plotR: colR, axisX, xOf: mkXOf(colL, colR),
          });
        });
      };
      // 左欄：刻度在左，繪圖區在右
      if (leftIds.length) {
        const colL = SIDE_AXIS, colR = leftColW - 2;
        stack(leftIds, "left", colL, Math.max(colL + 20, colR), 0);
      }
      // 右欄：繪圖區在左，刻度在右
      if (rightIds.length) {
        const colL = cssW - rightColW + 2, colR = cssW - SIDE_AXIS;
        stack(rightIds, "right", colL, Math.max(colL + 20, colR), colR);
      }

      const hovPane = mouse && panes.find(p => mouse.y >= p.top && mouse.y < p.top + p.h
        && mouse.x >= (p.plotL !== undefined ? p.plotL : plotL) && mouse.x < (p.plotR !== undefined ? p.plotR : plotR));
      let hovIdx = -1;
      if (hovPane) {
        if (hovPane.side === "center" || !hovPane.side) {
          hovIdx = Math.max(0, Math.min(n - 1, Math.round(idxAt(Math.min(plotR, Math.max(plotL, mouse.x))))));
        } else {
          const scale = (hovPane.plotR - hovPane.plotL) / Math.max(1, plotW);
          const barW2 = v.barW * scale;
          hovIdx = Math.max(0, Math.min(n - 1, Math.round(v.right - (hovPane.plotR - barW2 / 2 - mouse.x) / barW2)));
        }
      }
      const infoIdx = hovIdx >= 0 ? hovIdx : Math.min(i1, n - 1);
      const ovLines = wrapItems(overlayLegend(infoIdx), plotW - 8);
      const L = { plotL, plotR, plotW, panes, bottom: avail, xOf, idxAt, n, leftColW, rightColW };
      layout = L;
      const hov = hovIdx;
      const step = Math.max(1, Math.ceil(80 / v.barW)), ticks = [];
      if (period === "T") { for (let i = 0; i < n; i += 30) if (i >= i0 && i <= i1) ticks.push(i); }
      else for (let i = Math.ceil(i0 / step) * step; i <= i1; i += step) ticks.push(i);

      for (const pane of panes) {
        const pL = pane.plotL !== undefined ? pane.plotL : plotL;
        const pR = pane.plotR !== undefined ? pane.plotR : plotR;
        const pW = pR - pL;
        const xOfP = pane.xOf || xOf;
        const top = pane.top + pane.hdr, h = Math.max(8, pane.h - pane.hdr - 3);
        g.strokeStyle = C.sep; g.lineWidth = 1;
        if (pane.side !== "center" && pane.top > 0) {
          g.beginPath(); g.moveTo(pL - 4, pane.top + 0.5); g.lineTo(pR + 4, pane.top + 0.5); g.stroke();
        } else if (pane.side === "center" && leftColW) {
          g.beginPath(); g.moveTo(leftColW + 0.5, 0); g.lineTo(leftColW + 0.5, avail); g.stroke();
        }
        if (pane.side === "center" && rightColW) {
          g.beginPath(); g.moveTo(cssW - rightColW + 0.5, 0); g.lineTo(cssW - rightColW + 0.5, avail); g.stroke();
        }
        g.strokeStyle = C.grid;
        for (const i of ticks) { const x = Math.round(xOfP(i)) + 0.5; if (x >= pL && x <= pR) { g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + h); g.stroke(); } }

        const spec = pane.id === "price" ? null : subSpec(pane.id, i0, i1, bars);
        let lo = Infinity, hi = -Infinity;
        const take = val => { if (Number.isFinite(val)) { if (val < lo) lo = val; if (val > hi) hi = val; } };
        if (!spec) {
          for (let i = i0; i <= i1; i++) {
            if (period === "T") take(bars[i].c); else { take(bars[i].l); take(bars[i].h); }
            for (const ov of (entry.overlays || [])) {
              const m = overlayCalc(ov);
              if (m.line) take(m.line[i]);
              if (m.up) { take(m.up[i]); take(m.lo[i]); }
              if (m.sar) take(m.sar[i]);
            }
          }
          if (period === "T") take(quote.price - quote.change);
        } else if (spec.fixed) { [lo, hi] = spec.fixed; }
        else {
          for (let i = i0; i <= i1; i++) {
            if (spec.vol) take(bars[i].v);
            if (spec.hist) take(spec.hist[i]);
            for (const ln of spec.lines) take(ln[0][i]);
          }
          if (spec.lo !== undefined) take(spec.lo);
          if (spec.sym) { const a = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -a; hi = a; }
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (!(hi > lo)) hi = lo + 1;
        if (!spec || !spec.fixed) { const m = (hi - lo) * 0.07; if (!(spec && spec.lo === 0 && lo === 0)) lo -= m; hi += m; }
        const yOf = val => top + h * (1 - (val - lo) / (hi - lo));
        Object.assign(pane, { lo, hi, y0: top, ph: h, yOf, valAt: y => lo + (1 - (y - top) / h) * (hi - lo) });

        // 刻度（左欄在左，其餘在右）
        const axisLeft = pane.side === "left";
        g.fillStyle = C.axis; g.textAlign = axisLeft ? "right" : "left";
        const axisTx = axisLeft ? pL - 4 : pR + 6;
        if (spec && spec.guides && spec.fixed) {
          for (const t of spec.guides) {
            const y = Math.round(yOf(t)) + 0.5;
            g.strokeStyle = C.grid; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(pL, y); g.lineTo(pR, y); g.stroke(); g.setLineDash([]);
            g.fillText(String(t), axisTx, y);
          }
        } else {
          const st = niceStep(hi - lo, spec ? Math.max(1, h / 30) : Math.max(2, h / 45));
          for (let t = Math.ceil(lo / st) * st; t <= hi; t += st) {
            const y = Math.round(yOf(t)) + 0.5;
            if (y < top + 4 || y > top + h - 2) continue;
            g.strokeStyle = C.grid; g.beginPath(); g.moveTo(pL, y); g.lineTo(pR, y); g.stroke();
            g.fillText(Math.abs(t) >= 10000 ? fmtV(t) : t.toFixed(st < 1 ? 2 : st < 10 ? 1 : 0), axisTx, y);
          }
          if (spec && spec.guides) for (const t of spec.guides) if (t > lo && t < hi) {
            const y = Math.round(yOf(t)) + 0.5;
            g.strokeStyle = "#3a3a3a"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(pL, y); g.lineTo(pR, y); g.stroke(); g.setLineDash([]);
          }
        }

        g.save();
        g.beginPath(); g.rect(pL, pane.top + 1, pW, pane.h - 1); g.clip();
        if (!spec) { try { drawPrice(bars, i0, i1, xOfP, yOf, v, L, top, h); } catch (e) { if (window.XQ_DEBUG && window.ipc) window.ipc.postMessage(JSON.stringify({ type: "log", msg: "drawPrice " + e.message })); } }
        else {
          const bwScale = pW / Math.max(1, plotW);
          if (spec.vol) {
            const bw = Math.max(1, v.barW * bwScale * 0.7);
            for (let i = i0; i <= i1; i++) {
              const b = bars[i], up = period === "T" ? (i === 0 || b.c >= bars[i - 1].c) : b.c >= b.o;
              g.fillStyle = up ? C.up + "aa" : C.down + "aa";
              const y = yOf(b.v); g.fillRect(xOfP(i) - bw / 2, y, bw, top + h - y);
            }
          }
          if (spec.hist) {
            const bw = Math.max(1, v.barW * bwScale * 0.6), y0 = yOf(0);
            for (let i = i0; i <= i1; i++) { const y = yOf(spec.hist[i]); g.fillStyle = spec.hist[i] >= 0 ? C.up : C.down; g.fillRect(xOfP(i) - bw / 2, Math.min(y, y0), bw, Math.abs(y - y0)); }
          }
          for (const ln of spec.lines) line(ln[0], ln[1], i0, i1, xOfP, yOf);
        }
        g.restore();
        legend(pane, spec, bars, infoIdx, { plotL: pL, plotR: pR }, ovLines);
      }

      // 時間軸（對齊主圖寬度）
      g.fillStyle = C.axis; g.textAlign = "center";
      g.strokeStyle = C.sep; g.beginPath(); g.moveTo(0, L.bottom + 0.5); g.lineTo(cssW, L.bottom + 0.5); g.stroke();
      for (const i of ticks) {
        const text = fmtTime(bars[i].t, period), half = g.measureText(text).width / 2 + 2;
        g.fillText(text, Math.max(plotL + half, Math.min(plotR - half, xOf(i))), L.bottom + TIME_H / 2 + 1);
      }
      g.strokeStyle = C.sep; g.beginPath(); g.moveTo(plotR + 0.5, 0); g.lineTo(plotR + 0.5, L.bottom); g.stroke();

      compositeDrawLayer(L);
      if (hov >= 0) crosshair(L, bars, hov);
      sync();
    }

    function line(arr, color, i0, i1, xOf, yOf, width = 1.2) {
      g.strokeStyle = color; g.lineWidth = width; g.beginPath();
      let started = false;
      for (let i = i0; i <= i1; i++) {
        const val = arr[i];
        if (!Number.isFinite(val)) { started = false; continue; }
        if (started) g.lineTo(xOf(i), yOf(val)); else { g.moveTo(xOf(i), yOf(val)); started = true; }
      }
      g.stroke(); g.lineWidth = 1;
    }

    function drawPrice(bars, i0, i1, xOf, yOf, v, L, top, h) {
      // 布林底色先畫
      (entry.overlays || []).forEach((ov) => {
        if (ov.type !== "bb") return;
        const m = overlayCalc(ov);
        g.beginPath();
        let first = true;
        for (let i = i0; i <= i1; i++) if (Number.isFinite(m.up[i])) { if (first) { g.moveTo(xOf(i), yOf(m.up[i])); first = false; } else g.lineTo(xOf(i), yOf(m.up[i])); }
        for (let i = i1; i >= i0; i--) if (Number.isFinite(m.lo[i])) g.lineTo(xOf(i), yOf(m.lo[i]));
        g.closePath(); g.fillStyle = "rgba(92,157,237,0.08)"; g.fill();
      });
      if (period === "T") {
        const pc = quote.price - quote.change;
        g.setLineDash([4, 4]); g.strokeStyle = "#777"; g.beginPath(); g.moveTo(L.plotL, yOf(pc)); g.lineTo(L.plotR, yOf(pc)); g.stroke(); g.setLineDash([]);
        const color = quote.change >= 0 ? C.up : C.down;
        g.beginPath();
        for (let i = i0; i <= i1; i++) (i === i0 ? g.moveTo : g.lineTo).call(g, xOf(i), yOf(bars[i].c));
        g.strokeStyle = color; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
        g.lineTo(xOf(i1), top + h); g.lineTo(xOf(i0), top + h); g.closePath();
        const grad = g.createLinearGradient(0, top, 0, top + h);
        grad.addColorStop(0, quote.change >= 0 ? "rgba(229,72,77,0.22)" : "rgba(48,164,108,0.22)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = grad; g.fill();
      } else {
        const bw = Math.max(1, Math.round(v.barW * 0.7));
        for (let i = i0; i <= i1; i++) {
          const b = bars[i], up = b.c >= b.o, x = Math.round(xOf(i));
          g.strokeStyle = g.fillStyle = up ? C.up : C.down;
          g.beginPath(); g.moveTo(x + 0.5, yOf(b.h)); g.lineTo(x + 0.5, yOf(b.l)); g.stroke();
          if (v.barW >= 3) { const y1 = yOf(Math.max(b.o, b.c)), y2 = yOf(Math.min(b.o, b.c)); g.fillRect(x - Math.floor(bw / 2) + 0.5, y1, bw, Math.max(1, y2 - y1)); }
        }
      }
      (entry.overlays || []).forEach((ov, idx) => {
        const col = OV_COLORS[idx % OV_COLORS.length], m = overlayCalc(ov);
        if (ov.type === "bb") {
          line(m.up, col, i0, i1, xOf, yOf); line(m.lo, col, i0, i1, xOf, yOf);
          g.setLineDash([4, 3]); line(m.mid, col, i0, i1, xOf, yOf, 1); g.setLineDash([]);
        } else if (ov.type === "ma" || ov.type === "ema") {
          line(m.line, col, i0, i1, xOf, yOf);
        } else if (ov.type === "sar") {
          const r = Math.max(1.2, Math.min(2.5, v.barW * 0.2));
          for (let i = i0; i <= i1; i++) if (Number.isFinite(m.sar[i])) {
            g.fillStyle = m.up[i] ? C.up : C.down;
            g.beginPath(); g.arc(xOf(i), yOf(m.sar[i]), r, 0, Math.PI * 2); g.fill();
          }
        }
      });
    }

    function legend(pane, spec, bars, i, L, ovLines) {
      g.textAlign = "left";
      let x = L.plotL + 4, y = pane.top + 8;
      const put = (text, color) => { g.fillStyle = color; g.fillText(text, x, y); x += g.measureText(text).width + 10; };
      if (!spec) {
        const b = bars[i], prev = period === "T" ? quote.price - quote.change : i > 0 ? bars[i - 1].c : b.o;
        const ch = b.c - prev, col = ch >= 0 ? C.up : C.down;
        put(`${PERIODS.find(p => p[0] === period)[1]}（假資料）`, C.axis);
        put(fmtTime(b.t, period, true), C.text);
        put(`開 ${fmtP(b.o)}`, C.text); put(`高 ${fmtP(b.h)}`, C.text); put(`低 ${fmtP(b.l)}`, C.text);
        put(`收 ${fmtP(b.c)}`, col); put(`${ch >= 0 ? "+" : ""}${ch.toFixed(2)} (${ch >= 0 ? "+" : ""}${((ch / prev) * 100).toFixed(2)}%)`, col);
        put(`量 ${fmtV(b.v)}`, C.text);
        for (const ln of ovLines) { x = L.plotL + 4; y += 14; for (const [t, col2] of ln) put(t, col2); }
        return;
      }
      put(spec.title, C.axis);
      if (spec.vol) put(fmtV(bars[i].v), C.text);
      for (const [arr, color, name] of spec.lines) put(`${name ? name + " " : ""}${spec.vol ? fmtV(arr[i]) : fmtAuto(arr[i])}`, color);
      if (spec.hist) put(`${spec.histName} ${fmtAuto(spec.hist[i])}`, spec.hist[i] >= 0 ? C.up : C.down);
    }

    function axisLabel(text, y, bg, atX) {
      const x = atX !== undefined ? atX : layout.plotR;
      g.fillStyle = bg; g.fillRect(x + 1, y - 8, AXIS_W - 2, 16);
      g.fillStyle = "#fff"; g.textAlign = "left"; g.fillText(text, x + 5, y);
    }

    function crosshair(L, bars, i) {
      const x = Math.round(L.xOf(i)) + 0.5, y = Math.round(mouse.y) + 0.5;
      g.strokeStyle = C.cross; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, L.bottom); g.moveTo(L.plotL, y); g.lineTo(L.plotR, y); g.stroke();
      g.setLineDash([]);
      const pane = L.panes.find(p => {
        const pL = p.plotL !== undefined ? p.plotL : L.plotL, pR = p.plotR !== undefined ? p.plotR : L.plotR;
        return mouse.y >= p.top && mouse.y < p.top + p.h && mouse.x >= pL && mouse.x < pR;
      }) || L.panes.find(p => p.id === "price");
      if (pane && pane.valAt) {
        const val = pane.valAt(mouse.y);
        const ax = pane.side === "left" ? 0 : (pane.plotR !== undefined ? pane.plotR : L.plotR);
        axisLabel(pane.id === "vol" || pane.id === "obv" ? fmtV(val) : fmtAuto(val), y, C.crossLabel, ax);
      }
      const text = fmtTime(bars[i].t, period, true), w = g.measureText(text).width + 10;
      const bx = Math.max(L.plotL, Math.min(L.plotR - w, x - w / 2));
      g.fillStyle = C.crossLabel; g.fillRect(bx, L.bottom + 1, w, TIME_H - 2);
      g.fillStyle = "#fff"; g.textAlign = "center"; g.fillText(text, bx + w / 2, L.bottom + TIME_H / 2 + 1);
    }

    // ---------- 畫線 ----------
    const priceLine = (a, b, i) => (b.i === a.i ? a.p : a.p + ((b.p - a.p) * (i - a.i)) / (b.i - a.i));
    function geom(d, L) {
      const pr = L.panes[0], P = pt => ({ x: L.xOf(pt.i), y: pr.yOf(pt.p) });
      const pts = d.pts.map(P), out = { pts, segs: [], handles: pts.slice(), fill: null };
      if (d.type === "trend") out.segs.push([pts[0], pts[1]]);
      else if (d.type === "ray") {
        const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y, T = 20000 / Math.max(1, Math.abs(dx), Math.abs(dy));
        out.segs.push([pts[0], { x: pts[0].x + dx * T, y: pts[0].y + dy * T }]);
      } else if (d.type === "hline") {
        out.segs.push([{ x: L.plotL, y: pts[0].y }, { x: L.plotR, y: pts[0].y }]);
        out.handles = [{ x: Math.max(L.plotL + 6, Math.min(L.plotR - 6, pts[0].x)), y: pts[0].y }];
      } else if (d.type === "vline") {
        out.segs.push([{ x: pts[0].x, y: pr.top }, { x: pts[0].x, y: pr.top + pr.h }]);
        out.handles = [{ x: pts[0].x, y: Math.max(pr.top + 6, Math.min(pr.top + pr.h - 6, pts[0].y)) }];
      } else if (d.type === "channel") {
        const [a, b] = d.pts, cpt = d.pts[2] || d.pts[1], off = cpt.p - priceLine(a, b, cpt.i);
        const a2 = P({ i: a.i, p: a.p + off }), b2 = P({ i: b.i, p: b.p + off });
        const am = P({ i: a.i, p: a.p + off / 2 }), bm = P({ i: b.i, p: b.p + off / 2 });
        out.segs.push([pts[0], pts[1]], [a2, b2]);
        out.mid = [am, bm];
        out.fill = [pts[0], pts[1], b2, a2];
        if (d.pts.length < 3) out.segs.pop();
      } else if (d.type === "fib") {
        const [a, b] = d.pts, x1 = Math.min(pts[0].x, pts[1].x), x2 = Math.max(pts[0].x, pts[1].x, x1 + 40);
        out.levels = FIB.map((lv, k) => { const p = b.p + (a.p - b.p) * lv; return { lv, p, y: pr.yOf(p), x1, x2, color: FIB_COLORS[k] }; });
        for (const lv of out.levels) out.segs.push([{ x: x1, y: lv.y }, { x: x2, y: lv.y }]);
        out.fillBox = [x1, Math.min(pts[0].y, pts[1].y), x2, Math.max(pts[0].y, pts[1].y)];
      } else if (d.type === "rect") {
        const [p, q] = pts, r = { x: q.x, y: p.y }, s = { x: p.x, y: q.y };
        out.segs.push([p, r], [r, q], [q, s], [s, p]);
        out.fill = [p, r, q, s];
        out.handles = [p, q, r, s];
      } else if (d.type === "text") {
        const ctx = (L && L._measureCtx) || g;
        ctx.font = "13px sans-serif";
        const w = ctx.measureText(d.text || "").width + 12;
        ctx.font = "11px sans-serif";
        out.box = [pts[0].x, pts[0].y - 11, w, 22];
      }
      return out;
    }

    function geomBBox(G, pad) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const add = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      };
      for (const [a, b] of (G.segs || [])) { add(a.x, a.y); add(b.x, b.y); }
      for (const p of (G.pts || [])) add(p.x, p.y);
      for (const p of (G.handles || [])) add(p.x, p.y);
      if (G.fill) for (const p of G.fill) add(p.x, p.y);
      if (G.mid) { add(G.mid[0].x, G.mid[0].y); add(G.mid[1].x, G.mid[1].y); }
      if (G.fillBox) { add(G.fillBox[0], G.fillBox[1]); add(G.fillBox[2], G.fillBox[3]); }
      if (G.box) { add(G.box[0], G.box[1]); add(G.box[0] + G.box[2], G.box[1] + G.box[3]); }
      if (G.levels) for (const lv of G.levels) { add(lv.x1, lv.y); add(lv.x2, lv.y); }
      if (!Number.isFinite(minX)) return null;
      const p = pad || 8;
      return { minX: minX - p, minY: minY - p, maxX: maxX + p, maxY: maxY + p };
    }

    function paintOneDrawing(ctx, d, idx, L, G, isPending) {
      const sel = !isPending && idx === selected, col = sel ? C.sel : C.draw;
      ctx.lineWidth = sel ? 2 : 1.4; ctx.strokeStyle = col;
      if (G.fill) {
        ctx.fillStyle = d.type === "rect" ? "rgba(255,176,0,0.10)" : "rgba(255,176,0,0.07)";
        ctx.beginPath(); G.fill.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
      }
      if (d.type === "fib") {
        G.levels.forEach((lv, k) => {
          if (k) { const prev = G.levels[k - 1]; ctx.fillStyle = lv.color + "14"; ctx.fillRect(lv.x1, Math.min(lv.y, prev.y), lv.x2 - lv.x1, Math.abs(lv.y - prev.y)); }
          ctx.strokeStyle = sel ? C.sel : lv.color; ctx.beginPath(); ctx.moveTo(lv.x1, lv.y); ctx.lineTo(lv.x2, lv.y); ctx.stroke();
          ctx.fillStyle = lv.color; ctx.textAlign = "left";
          ctx.fillText(`${lv.lv} (${fmtP(lv.p)})`, lv.x1 + 3, lv.y - 7);
        });
        ctx.strokeStyle = col; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(G.pts[0].x, G.pts[0].y); ctx.lineTo(G.pts[1].x, G.pts[1].y); ctx.stroke(); ctx.setLineDash([]);
      } else if (d.type === "text") {
        const [x, y, w, h] = G.box;
        ctx.fillStyle = "rgba(30,30,30,0.85)"; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = col; ctx.lineWidth = sel ? 2 : 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        ctx.font = "13px sans-serif"; ctx.fillStyle = C.draw; ctx.textAlign = "left"; ctx.fillText(d.text || "", x + 6, y + h / 2 + 1); ctx.font = "11px sans-serif";
      } else {
        ctx.beginPath(); for (const [p, q] of G.segs) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); } ctx.stroke();
        if (G.mid) { ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(G.mid[0].x, G.mid[0].y); ctx.lineTo(G.mid[1].x, G.mid[1].y); ctx.stroke(); ctx.setLineDash([]); }
      }
      if (sel || isPending) {
        ctx.fillStyle = col;
        for (const h of G.handles) {
          ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
          ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.strokeRect(h.x - 4.5, h.y - 4.5, 9, 9);
        }
      }
    }

    function paintHlineLabels(ctx, L, list) {
      const pr = L.panes[0];
      const axisX = L.plotR;
      list.forEach((d, idx) => {
        if (d.type !== "hline") return;
        const y = pr.yOf(d.pts[0].p);
        if (y <= pr.top + 8 || y >= pr.top + pr.h - 8) return;
        const text = fmtP(d.pts[0].p), bg = idx === selected ? "#666" : "#8a6a00";
        ctx.fillStyle = bg; ctx.fillRect(axisX + 1, y - 8, AXIS_W - 2, 16);
        ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.fillText(text, axisX + 5, y);
      });
    }

    function ensureDrawLayerSize(dpr) {
      const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
      if (drawLayer.width !== w || drawLayer.height !== h) {
        drawLayer.width = w; drawLayer.height = h;
        drawLayerDirty = true;
      }
    }

    function rebuildSpatial(L) {
      const list = drawings();
      const cell = 64;
      const cols = Math.max(1, Math.ceil(Math.max(1, cssW) / cell));
      const rows = Math.max(1, Math.ceil(Math.max(1, cssH) / cell));
      const buckets = new Array(cols * rows);
      for (let i = 0; i < buckets.length; i++) buckets[i] = [];
      const geoms = new Array(list.length);
      L._measureCtx = drawG;
      for (let k = 0; k < list.length; k++) {
        const G = geom(list[k], L);
        geoms[k] = G;
        const bb = geomBBox(G, 8);
        if (!bb) continue;
        const c0 = Math.max(0, Math.floor(bb.minX / cell));
        const c1 = Math.min(cols - 1, Math.floor(bb.maxX / cell));
        const r0 = Math.max(0, Math.floor(bb.minY / cell));
        const r1 = Math.min(rows - 1, Math.floor(bb.maxY / cell));
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) buckets[r * cols + c].push(k);
      }
      spatial = { cell, cols, rows, buckets, geoms };
      spatialDirty = false;
    }

    function rebuildDrawLayer(L) {
      const dpr = window.devicePixelRatio || 1;
      ensureDrawLayerSize(dpr);
      drawG.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawG.clearRect(0, 0, cssW, cssH);
      drawG.font = "11px sans-serif";
      drawG.textBaseline = "middle";
      const pr = L.panes[0], list = drawings();
      L._measureCtx = drawG;
      // selected 在拖曳／高亮時每幀即時畫，不進靜態快取（行情 tick 也不必重建）
      drawG.save();
      drawG.beginPath(); drawG.rect(L.plotL, pr.top, L.plotW, pr.h); drawG.clip();
      for (let idx = 0; idx < list.length; idx++) {
        if (idx === selected) continue;
        const d = list[idx];
        paintOneDrawing(drawG, d, idx, L, geom(d, L), false);
      }
      drawG.restore();
      drawG.lineWidth = 1;
      paintHlineLabels(drawG, L, list.filter((_, i) => i !== selected));
      drawLayerDirty = false;
      rebuildSpatial(L);
      drawViewKey = layoutFingerprint(L, view());
    }

    function compositeDrawLayer(L) {
      const fp = layoutFingerprint(L, view());
      if (fp !== drawViewKey) drawLayerDirty = true;
      if (drawLayerDirty) rebuildDrawLayer(L);
      else if (spatialDirty) rebuildSpatial(L);
      // 實體像素層直接貼上（避開目前的 dpr transform）
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(drawLayer, 0, 0);
      g.restore();
      // pending／selected 每幀即時疊上，不進靜態快取
      const list = drawings();
      const live = [];
      if (selected >= 0 && list[selected]) live.push([list[selected], selected, false]);
      if (pending) live.push([pending, -1, true]);
      if (live.length) {
        const pr = L.panes[0];
        L._measureCtx = g;
        g.save();
        g.beginPath(); g.rect(L.plotL, pr.top, L.plotW, pr.h); g.clip();
        for (const [d, idx, isPending] of live) paintOneDrawing(g, d, idx, L, geom(d, L), isPending);
        g.restore(); g.lineWidth = 1;
        if (selected >= 0 && list[selected] && list[selected].type === "hline") {
          const d = list[selected];
          const pr = L.panes[0];
          const y = pr.yOf(d.pts[0].p);
          if (y > pr.top + 8 && y < pr.top + pr.h - 8) {
            const text = fmtP(d.pts[0].p);
            g.fillStyle = "#666"; g.fillRect(L.plotR + 1, y - 8, AXIS_W - 2, 16);
            g.fillStyle = "#fff"; g.textAlign = "left"; g.fillText(text, L.plotR + 5, y);
          }
        }
      }
    }

    function distSeg(p, a, b) {
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }
    function inPoly(p, poly) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    }
    function hitGeom(p, G) {
      if (!G) return false;
      if (G.segs && G.segs.some(([a, b]) => distSeg(p, a, b) <= 6)) return true;
      if (G.fill && inPoly(p, G.fill)) return true;
      if (G.fillBox && p.x >= G.fillBox[0] && p.x <= G.fillBox[2] && p.y >= G.fillBox[1] && p.y <= G.fillBox[3]) return true;
      if (G.box && p.x >= G.box[0] && p.x <= G.box[0] + G.box[2] && p.y >= G.box[1] && p.y <= G.box[1] + G.box[3]) return true;
      return false;
    }
    // 回傳 { idx, handle }；handle = 控制點索引，-1 = 整條
    function hitTest(p) {
      if (!layout) return null;
      const list = drawings();
      if (drawLayerDirty || spatialDirty || !spatial.geoms || spatial.geoms.length !== list.length) {
        rebuildSpatial(layout);
      }
      if (selected >= 0 && list[selected]) {
        const G = spatial.geoms[selected] || geom(list[selected], layout);
        const hk = G.handles.findIndex(h => Math.abs(h.x - p.x) <= 6 && Math.abs(h.y - p.y) <= 6);
        if (hk >= 0) return { idx: selected, handle: hk };
      }
      const { cell, cols, rows, buckets, geoms } = spatial;
      const c = Math.max(0, Math.min(cols - 1, Math.floor(p.x / cell)));
      const r = Math.max(0, Math.min(rows - 1, Math.floor(p.y / cell)));
      // 鄰近 3x3 cell，避免壓在邊界上漏打
      const cand = [];
      const seen = new Set();
      for (let rr = Math.max(0, r - 1); rr <= Math.min(rows - 1, r + 1); rr++) {
        for (let cc = Math.max(0, c - 1); cc <= Math.min(cols - 1, c + 1); cc++) {
          const bucket = buckets[rr * cols + cc];
          for (let i = 0; i < bucket.length; i++) {
            const idx = bucket[i];
            if (!seen.has(idx)) { seen.add(idx); cand.push(idx); }
          }
        }
      }
      cand.sort((a, b) => b - a);
      for (const k of cand) {
        if (hitGeom(p, geoms[k])) return { idx: k, handle: -1 };
      }
      return null;
    }
    // 拖控制點：矩形的 4 個角對應到 2 個點
    function applyHandle(d, hk, a, orig) {
      if (d.type === "rect") {
        const [p, q] = orig;
        if (hk === 0) d.pts[0] = { ...a };
        else if (hk === 1) d.pts[1] = { ...a };
        else if (hk === 2) { d.pts[0] = { i: p.i, p: a.p }; d.pts[1] = { i: a.i, p: q.p }; }
        else { d.pts[0] = { i: a.i, p: p.p }; d.pts[1] = { i: q.i, p: a.p }; }
      } else d.pts[hk] = { ...a };
    }

    // ---------- 滑鼠 ----------
    const local = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const inPrice = p => { const pr = layout && layout.panes[0]; return pr && p.x >= layout.plotL && p.x < layout.plotR && p.y >= pr.top && p.y < pr.top + pr.h; };
    const toAnchor = p => ({ i: layout.idxAt(p.x), p: layout.panes[0].valAt(p.y) });

    function finishDrawing(d) {
      delete d.dragging; delete d.sx; delete d.sy;
      drawings().push(d);
      selected = drawings().length - 1;
      pending = null; tool = "cursor";
      markDrawingsDirty();
      save(); sync();
    }

    // 文字註記用的輸入框（不用 window.prompt）
    const textInput = document.createElement("input");
    textInput.className = "chart-text-input"; textInput.type = "text"; textInput.placeholder = "輸入文字，Enter 確定，Esc 取消";
    textInput.hidden = true;
    wrap.appendChild(textInput);
    let textCtx = null;
    function openText(p, editIdx) {
      const d = editIdx >= 0 ? drawings()[editIdx] : null;
      textCtx = { anchor: d ? d.pts[0] : toAnchor(p), editIdx };
      textInput.value = d ? d.text : "";
      textInput.style.left = Math.min(p.x, cssW - 230) + "px";
      textInput.style.top = Math.max(0, p.y - 13) + "px";
      textInput.hidden = false;
      setTimeout(() => textInput.focus(), 0);
    }
    function closeText(commit) {
      if (!textCtx) return;
      const ctx = textCtx, text = textInput.value.trim();
      textCtx = null; textInput.hidden = true;
      if (commit) {
        if (ctx.editIdx >= 0) {
          if (text) drawings()[ctx.editIdx].text = text; else drawings().splice(ctx.editIdx, 1);
          selected = -1; markDrawingsDirty(); save();
        } else if (text) finishDrawing({ type: "text", pts: [ctx.anchor], text });
      }
      tool = "cursor"; sync(); render();
    }
    textInput.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") closeText(true);
      if (e.key === "Escape") closeText(false);
    });
    textInput.addEventListener("blur", () => closeText(true));
    textInput.addEventListener("mousedown", e => e.stopPropagation());

    canvas.addEventListener("mousedown", e => {
      if (e.button !== 0 || !quote || !layout) return;
      e.preventDefault();
      if (textCtx) { closeText(true); return; }
      const p = local(e);
      if (p.x >= layout.plotR || p.y >= layout.bottom) return;
      if (tool === "draw") {
        if (!inPrice(p)) return;
        const a = toAnchor(p);
        if (drawTool === "text") { openText(p, -1); return; }
        if (pending) {
          pending.pts[pending.pts.length - 1] = a;
          if (pending.pts.length >= NEED[pending.type]) finishDrawing(pending);
          else { pending.pts.push({ ...a }); pending.dragging = true; pending.sx = p.x; pending.sy = p.y; }
        } else if (NEED[drawTool] === 1) finishDrawing({ type: drawTool, pts: [a] });
        else pending = { type: drawTool, pts: [a, { ...a }], dragging: true, sx: p.x, sy: p.y };
      } else {
        const hit = hitTest(p);
        const prevSel = selected;
        if (hit) {
          selected = hit.idx;
          drag = { idx: hit.idx, handle: hit.handle, start: toAnchor(p), orig: clone(drawings()[hit.idx].pts), moved: false };
        } else { selected = -1; pan = { x: p.x, right: view().right }; }
        if (selected !== prevSel) markDrawingsDirty();
      }
      sync(); requestRender();
    });
    canvas.addEventListener("dblclick", e => {
      const p = local(e), hit = layout && hitTest(p);
      if (hit && drawings()[hit.idx].type === "text") openText(p, hit.idx);
    });
    canvas.addEventListener("mousemove", e => {
      const p = local(e);
      if (mouse && Math.abs(p.x - mouse.x) < 0.5 && Math.abs(p.y - mouse.y) < 0.5
          && !(pending && !pending.dragging)) return;
      mouse = p;
      if (pending && !pending.dragging && layout) pending.pts[pending.pts.length - 1] = toAnchor(mouse);
      requestRender();
    });
    canvas.addEventListener("mouseleave", () => { if (!pan && !drag && !(pending && pending.dragging)) { mouse = null; requestRender(); } });
    window.addEventListener("mousemove", e => {
      if (!pan && !drag && !(pending && pending.dragging)) return;
      mouse = local(e);
      if (pan) { const v = view(); v.right = pan.right + (pan.x - mouse.x) / v.barW; }
      if (pending && pending.dragging) pending.pts[pending.pts.length - 1] = toAnchor(mouse);
      if (drag && layout) {
        const d = drawings()[drag.idx], a = toAnchor(mouse);
        if (!d) { drag = null; return; }
        drag.moved = true;
        if (drag.handle >= 0) applyHandle(d, drag.handle, a, drag.orig);
        else {
          const di = a.i - drag.start.i, dp = a.p - drag.start.p;
          d.pts = drag.orig.map(pt => ({ i: pt.i + di, p: pt.p + dp }));
        }
      }
      requestRender();
    });
    window.addEventListener("mouseup", e => {
      if (pan) pan = null;
      if (drag) { if (drag.moved) { save(); markDrawingsDirty(); } drag = null; }
      if (pending && pending.dragging) {
        const p = local(e);
        pending.dragging = false;
        if (Math.hypot(p.x - pending.sx, p.y - pending.sy) > 4) {
          pending.pts[pending.pts.length - 1] = toAnchor(p);
          if (pending.pts.length >= NEED[pending.type]) finishDrawing(pending);
          else pending.pts.push(toAnchor(p));  // 平行通道：再點一下決定寬度
        }
      }
      sync(); requestRender();
    });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      if (!layout) return;
      const p = local(e), v = view(), x = Math.min(p.x, layout.plotR), anchor = layout.idxAt(x);
      v.barW *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
      clampView(v, layout.n);
      v.right = anchor + (layout.plotR - v.barW / 2 - x) / v.barW;
      requestRender();
    }, { passive: false });
    document.addEventListener("keydown", e => {
      const t = e.target && e.target.tagName;
      if (t === "INPUT" || t === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") { deleteSelected(); requestRender(); }
      if (e.key === "Escape") { pending = null; tool = "cursor"; if (selected >= 0) markDrawingsDirty(); selected = -1; closeMenus(); sync(); requestRender(); }
    });

    // ---------- 即時行情 tick（高頻）：只動最後一根／指標 memo，畫線層沿用快取 ----------
    function invalidateSeriesMemo() {
      const s = quote && entry ? series() : null;
      if (s) s.memo = {};
      // 同源日線也清（週／月／分時可能共用 daily 衍生）
      if (quote) {
        const dk = `${quote.symbol}|D`;
        if (cache[dk]) cache[dk].memo = {};
      }
    }
    function applyTick(tick) {
      if (!quote || !entry || !tick) return false;
      if (tick.symbol && tick.symbol !== quote.symbol) return false;
      if (Number.isFinite(tick.price)) quote.price = tick.price;
      if (Number.isFinite(tick.change)) quote.change = tick.change;
      const s = series();
      const bars = s.bars;
      if (!bars.length) return false;
      const last = bars[bars.length - 1];
      const px = Number.isFinite(tick.price) ? tick.price : last.c;
      if (tick.append) {
        const bar = tick.bar || { t: tick.t != null ? tick.t : (period === "T" ? (typeof last.t === "number" ? last.t + 1 : last.t) : last.t), o: px, h: px, l: px, c: px, v: tick.volume || 0 };
        bars.push(bar);
        // 新 K 棒可能改變可視右緣；視窗跟到手尾
        const v = view();
        if (v.right >= bars.length - 3) v.right = bars.length - 1 + (period === "T" ? 0 : 2);
      } else {
        last.c = px;
        if (Number.isFinite(tick.high)) last.h = Math.max(last.h, tick.high); else last.h = Math.max(last.h, px);
        if (Number.isFinite(tick.low)) last.l = Math.min(last.l, tick.low); else last.l = Math.min(last.l, px);
        if (Number.isFinite(tick.open)) last.o = tick.open;
        if (Number.isFinite(tick.volume)) last.v = tick.volume;
        else if (Number.isFinite(tick.volumeDelta)) last.v = (last.v || 0) + tick.volumeDelta;
      }
      invalidateSeriesMemo();
      // 畫線錨在 bar index／價格；尺度若變 layoutFingerprint 會自動重建畫線層。
      // 預設 rAF 合併；量測迴圈可傳 { sync:true } 立刻 render。
      if (tick && tick.sync) render();
      else requestRender();
      return true;
    }

    function __perfClear() {
      if (!entry) return 0;
      drawings().length = 0; selected = -1; pending = null; drag = null;
      markDrawingsDirty(); sync(); render();
      return 0;
    }
    function __perfAddN(n, type) {
      type = type || "trend";
      if (!quote || !entry) throw new Error("chart not ready");
      const { bars } = series();
      const nBars = bars.length;
      const list = drawings();
      for (let k = 0; k < n; k++) {
        const i = Math.floor((k * 37 + 11) % Math.max(2, nBars - 40));
        const j = Math.min(nBars - 1, i + 20 + (k % 30));
        const a = bars[i], b = bars[j];
        const p0 = a.c, p1 = b.c * (1 + ((k % 7) - 3) * 0.002);
        if (type === "hline") list.push({ type: "hline", pts: [{ i, p: p0 }] });
        else if (type === "vline") list.push({ type: "vline", pts: [{ i, p: p0 }] });
        else if (type === "fib") list.push({ type: "fib", pts: [{ i, p: Math.max(p0, p1) }, { i: j, p: Math.min(p0, p1) }] });
        else if (type === "rect") list.push({ type: "rect", pts: [{ i, p: p0 }, { i: j, p: p1 }] });
        else if (type === "channel") list.push({ type: "channel", pts: [{ i, p: p0 }, { i: j, p: p1 }, { i: Math.floor((i + j) / 2), p: (p0 + p1) / 2 * 1.01 }] });
        else if (type === "text") list.push({ type: "text", pts: [{ i, p: p0 }], text: "T" + k });
        else if (type === "ray") list.push({ type: "ray", pts: [{ i, p: p0 }, { i: j, p: p1 }] });
        else list.push({ type: "trend", pts: [{ i, p: p0 }, { i: j, p: p1 }] });
      }
      selected = -1; markDrawingsDirty(); sync(); render();
      return list.length;
    }
    function __perfMeasure(opts) {
      opts = opts || {};
      const frames = opts.frames || 30;
      const withHit = !!opts.hitTest;
      const crosshairOnly = !!opts.crosshairOnly;
      const times = [];
      render(); // warm + build caches
      for (let i = 0; i < frames; i++) {
        if (crosshairOnly) {
          mouse = { x: 80 + (i * 17) % Math.max(40, cssW - 160), y: Math.min(cssH * 0.35, 140) };
        }
        const t0 = performance.now();
        render();
        if (withHit && layout) {
          for (let x = 40; x < cssW - 80; x += 80) hitTest({ x, y: Math.min(cssH * 0.3, 120) });
        }
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const sum = times.reduce((a, b) => a + b, 0);
      const avg = sum / times.length;
      const p50 = times[Math.floor(times.length * 0.5)];
      const p95 = times[Math.floor(times.length * 0.95)];
      return {
        count: drawings().length,
        frames,
        avgMs: +avg.toFixed(3),
        p50Ms: +p50.toFixed(3),
        p95Ms: +p95.toFixed(3),
        minMs: +times[0].toFixed(3),
        maxMs: +times[times.length - 1].toFixed(3),
        jsonBytes: JSON.stringify(drawings()).length,
        cssW, cssH,
        dpr: window.devicePixelRatio || 1,
        canvasW: canvas.width, canvasH: canvas.height,
        isWebGL: false, contextType: "2d", withHit, crosshairOnly,
        drawLayerDirty, spatialBuckets: spatial.buckets ? spatial.buckets.length : 0,
      };
    }
    async function __perfContinuous(ms) {
      ms = ms || 1500;
      let frames = 0;
      const t0 = performance.now();
      await new Promise(resolve => {
        function tick() {
          // 模擬高頻行情：每幀更新最後收盤，同步重繪（量測用）
          if (quote && entry) {
            const bars = series().bars; const last = bars[bars.length - 1];
            const wobble = Math.sin(frames / 7) * 0.15;
            applyTick({ price: last.c + wobble, volumeDelta: 1, sync: true });
          } else render();
          frames++;
          if (performance.now() - t0 >= ms) resolve();
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
      const elapsed = performance.now() - t0;
      return { frames, elapsedMs: +elapsed.toFixed(1), fps: +(frames * 1000 / elapsed).toFixed(1), count: drawings().length };
    }

    return {
      setQuote(q) {
        if (quote && quote.symbol === q.symbol) return;
        quote = q; loadEntry(); closeMenus(); sync(); render();
      },
      /** 同商品高頻報價／最後一根 K 更新（不重載分頁狀態、不強制重建畫線層）。 */
      updateQuote(tick) { return applyTick(tick || {}); },
      /** 切換走勢圖分頁：tabId 不同時即使同代號也會重載該分頁的指標／畫線。 */
      setContext(ctx) {
        if (!ctx || !ctx.quote) return;
        tabId = ctx.tabId || tabId;
        period = PERIODS.some(p => p[0] === ctx.period) ? ctx.period : period;
        quote = ctx.quote;
        loadEntry();
        delete views[key()]; // 分頁／版面寬度改變時重算可視範圍，避免 K 線跑出畫面
        closeMenus(); sync(); render();
      },
      getContext() { return { tabId, symbol: quote && quote.symbol, period }; },
      onMeta(cb) { metaCb = typeof cb === "function" ? cb : null; },
      resize,
      render,
      requestRender,
      __perf: { clear: __perfClear, addN: __perfAddN, measure: __perfMeasure, continuous: __perfContinuous, count: () => (entry ? drawings().length : 0) },
    };
  }

  window.XQChart = { create };
})();
