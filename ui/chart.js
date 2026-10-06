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
  // 指標面板：[id, 群組, 名稱, 參數 [key, 標籤, 是否小數]]
  const IND_DEFS = [
    ["ma", "main", "MA 移動平均", [["p1", "週期"], ["p2", ""], ["p3", ""]]],
    ["ema", "main", "EMA 指數平均", [["p1", "週期"], ["p2", ""]]],
    ["bb", "main", "布林通道", [["n", "週期"], ["k", "倍數", true]]],
    ["sar", "main", "拋物線 SAR", [["step", "加速", true], ["max", "上限", true]]],
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
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify({ type: "save", data: store }));
    }, 300);
  }

  // ---------- 圖表 ----------
  function create(canvas, toolbar) {
    const g = canvas.getContext("2d");
    const host = toolbar.parentElement;       // #top（選單掛在這裡）
    const wrap = canvas.parentElement;        // #chart-wrap（文字輸入框掛在這裡）
    const cache = {}, views = {};
    let quote = null, period = PERIODS.some(p => p[0] === store.ui.period) ? store.ui.period : "T";
    let entry = null;                         // { cfg, drawings } of current symbol|period
    let lastCfg = null;
    let tool = "cursor", drawTool = "trend", selected = -1;
    let mouse = null, pan = null, pending = null, drag = null, layout = null;
    let cssW = 0, cssH = 0;

    const key = () => `${quote.symbol}|${period}`;
    function loadEntry() {
      const k = key();
      if (!store.keys[k]) store.keys[k] = { cfg: clone(lastCfg || DEFAULT_CFG), drawings: [] };
      entry = store.keys[k];
      entry.cfg = mergeCfg(entry.cfg);
      if (!Array.isArray(entry.drawings)) entry.drawings = [];
      entry.drawings = entry.drawings.filter(d => d && NEED[d.type] && Array.isArray(d.pts));
      lastCfg = entry.cfg;
      selected = -1; pending = null; drag = null;
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
    mkBtn(gp, "clear", "全部清除", () => { drawings().length = 0; selected = -1; save(); sync(); render(); });
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
      for (const [grp, title] of [["main", "主圖（疊在 K 線上）"], ["sub", "副圖（下方小圖）"]]) {
        const h = document.createElement("div"); h.className = "menu-title"; h.textContent = title; indMenu.appendChild(h);
        for (const [id, g2, label, params] of IND_DEFS) {
          if (g2 !== grp) continue;
          // 只有「勾選框＋名稱」包在 label 裡；點參數輸入框不會切換勾選。
          const row = document.createElement("div"); row.className = "ind-row";
          const lab = document.createElement("label"); lab.className = "ind-name";
          const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!cfg()[id].on;
          cb.addEventListener("change", () => { cfg()[id].on = cb.checked; changed(); });
          lab.append(cb, document.createTextNode(" " + label));
          row.append(lab);
          for (const [pk, pl, isFloat] of params) {
            if (pl) { const s = document.createElement("span"); s.className = "ind-pl"; s.textContent = pl; row.appendChild(s); }
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
      }
      const reset = document.createElement("button");
      reset.className = "menu-item"; reset.textContent = "恢復預設指標";
      reset.addEventListener("click", () => { entry.cfg = clone(DEFAULT_CFG); lastCfg = entry.cfg; buildIndMenu(); changed(); });
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
      closeMenus(); sync(); render();
    }
    function deleteSelected() {
      if (selected >= 0) { drawings().splice(selected, 1); selected = -1; save(); }
      sync();
    }

    // ---------- 重繪 ----------
    let queued = false;
    function requestRender() {
      if (queued) return;
      queued = true;
      const run = () => { if (queued) { queued = false; render(); } };
      requestAnimationFrame(run);
      setTimeout(run, 40);
    }
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      cssW = canvas.clientWidth; cssH = canvas.clientHeight;
      const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      render();
    }

    function overlayLegend(i) {
      const items = [], c = cfg();
      if (c.ma.on) { const m = ind("ma"); items.push([`MA${c.ma.p1} ${fmtP(m.a[i])}`, C.ma[0]], [`MA${c.ma.p2} ${fmtP(m.b[i])}`, C.ma[1]], [`MA${c.ma.p3} ${fmtP(m.c[i])}`, C.ma[2]]); }
      if (c.ema.on) { const m = ind("ema"); items.push([`EMA${c.ema.p1} ${fmtP(m.a[i])}`, C.ema[0]], [`EMA${c.ema.p2} ${fmtP(m.b[i])}`, C.ema[1]]); }
      if (c.bb.on) { const m = ind("bb"); items.push([`BB(${c.bb.n},${c.bb.k}) 上 ${fmtP(m.up[i])} 中 ${fmtP(m.mid[i])} 下 ${fmtP(m.lo[i])}`, C.bb]); }
      if (c.sar.on) { const m = ind("sar"); items.push([`SAR ${fmtP(m.sar[i])}`, C.sar]); }
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
      const plotR = cssW - AXIS_W, plotW = plotR - PLOT_L;
      clampView(v, n);
      const xOf = i => plotR - (v.right - i) * v.barW - v.barW / 2;
      const idxAt = x => v.right - (plotR - v.barW / 2 - x) / v.barW;
      const i0 = Math.max(0, Math.floor(idxAt(PLOT_L))), i1 = Math.min(n - 1, Math.ceil(idxAt(plotR)));

      // 版面
      const subs = SUB_ORDER.filter(id => c[id] && c[id].on);
      const avail = cssH - TIME_H;
      let subH = subs.length ? Math.max(34, Math.min(110, avail * (subs.length <= 2 ? 0.2 : 0.14))) : 0;
      if (subs.length && avail - subH * subs.length < 100) subH = Math.max(22, (avail - 100) / subs.length);
      const priceH = Math.max(50, avail - subH * subs.length);
      const hov = mouse && mouse.x >= PLOT_L && mouse.x < plotR && mouse.y < priceH + subH * subs.length
        ? Math.max(0, Math.min(n - 1, Math.round(idxAt(mouse.x)))) : -1;
      const infoIdx = hov >= 0 ? hov : Math.min(i1, n - 1);
      const ovLines = wrapItems(overlayLegend(infoIdx), plotW - 8);
      const panes = [{ id: "price", top: 0, h: priceH, hdr: 16 + 14 * ovLines.length }];
      let yy = priceH;
      for (const id of subs) { panes.push({ id, top: yy, h: subH, hdr: 13 }); yy += subH; }
      const L = { plotL: PLOT_L, plotR, plotW, panes, bottom: yy, xOf, idxAt, n };
      layout = L;

      const step = Math.max(1, Math.ceil(80 / v.barW)), ticks = [];
      if (period === "T") { for (let i = 0; i < n; i += 30) if (i >= i0 && i <= i1) ticks.push(i); }
      else for (let i = Math.ceil(i0 / step) * step; i <= i1; i += step) ticks.push(i);

      for (const pane of panes) {
        const top = pane.top + pane.hdr, h = Math.max(8, pane.h - pane.hdr - 3);
        g.strokeStyle = C.sep; g.lineWidth = 1;
        if (pane.top > 0) { g.beginPath(); g.moveTo(0, pane.top + 0.5); g.lineTo(cssW, pane.top + 0.5); g.stroke(); }
        g.strokeStyle = C.grid;
        for (const i of ticks) { const x = Math.round(xOf(i)) + 0.5; g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + h); g.stroke(); }

        const spec = pane.id === "price" ? null : subSpec(pane.id, i0, i1, bars);
        let lo = Infinity, hi = -Infinity;
        const take = val => { if (Number.isFinite(val)) { if (val < lo) lo = val; if (val > hi) hi = val; } };
        if (!spec) {
          for (let i = i0; i <= i1; i++) {
            if (period === "T") take(bars[i].c); else { take(bars[i].l); take(bars[i].h); }
            if (c.ma.on) { const m = ind("ma"); take(m.a[i]); take(m.b[i]); take(m.c[i]); }
            if (c.ema.on) { const m = ind("ema"); take(m.a[i]); take(m.b[i]); }
            if (c.bb.on) { const m = ind("bb"); take(m.up[i]); take(m.lo[i]); }
            if (c.sar.on) take(ind("sar").sar[i]);
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

        // 右側刻度
        g.fillStyle = C.axis; g.textAlign = "left";
        if (spec && spec.guides && spec.fixed) {
          for (const t of spec.guides) {
            const y = Math.round(yOf(t)) + 0.5;
            g.strokeStyle = C.grid; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(PLOT_L, y); g.lineTo(plotR, y); g.stroke(); g.setLineDash([]);
            g.fillText(String(t), plotR + 6, y);
          }
        } else {
          const st = niceStep(hi - lo, spec ? Math.max(1, h / 30) : Math.max(2, h / 45));
          for (let t = Math.ceil(lo / st) * st; t <= hi; t += st) {
            const y = Math.round(yOf(t)) + 0.5;
            if (y < top + 4 || y > top + h - 2) continue;
            g.strokeStyle = C.grid; g.beginPath(); g.moveTo(PLOT_L, y); g.lineTo(plotR, y); g.stroke();
            g.fillText(Math.abs(t) >= 10000 ? fmtV(t) : t.toFixed(st < 1 ? 2 : st < 10 ? 1 : 0), plotR + 6, y);
          }
          if (spec && spec.guides) for (const t of spec.guides) if (t > lo && t < hi) {
            const y = Math.round(yOf(t)) + 0.5;
            g.strokeStyle = "#3a3a3a"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(PLOT_L, y); g.lineTo(plotR, y); g.stroke(); g.setLineDash([]);
          }
        }

        g.save();
        g.beginPath(); g.rect(PLOT_L, pane.top + 1, plotW, pane.h - 1); g.clip();
        if (!spec) drawPrice(bars, i0, i1, xOf, yOf, v, L, top, h);
        else {
          if (spec.vol) {
            const bw = Math.max(1, v.barW * 0.7);
            for (let i = i0; i <= i1; i++) {
              const b = bars[i], up = period === "T" ? (i === 0 || b.c >= bars[i - 1].c) : b.c >= b.o;
              g.fillStyle = up ? C.up + "aa" : C.down + "aa";
              const y = yOf(b.v); g.fillRect(xOf(i) - bw / 2, y, bw, top + h - y);
            }
          }
          if (spec.hist) {
            const bw = Math.max(1, v.barW * 0.6), y0 = yOf(0);
            for (let i = i0; i <= i1; i++) { const y = yOf(spec.hist[i]); g.fillStyle = spec.hist[i] >= 0 ? C.up : C.down; g.fillRect(xOf(i) - bw / 2, Math.min(y, y0), bw, Math.abs(y - y0)); }
          }
          for (const ln of spec.lines) line(ln[0], ln[1], i0, i1, xOf, yOf);
        }
        g.restore();
        legend(pane, spec, bars, infoIdx, L, ovLines);
      }

      // 時間軸
      g.fillStyle = C.axis; g.textAlign = "center";
      g.strokeStyle = C.sep; g.beginPath(); g.moveTo(0, L.bottom + 0.5); g.lineTo(cssW, L.bottom + 0.5); g.stroke();
      for (const i of ticks) {
        const text = fmtTime(bars[i].t, period), half = g.measureText(text).width / 2 + 2;
        g.fillText(text, Math.max(half, Math.min(plotR - half, xOf(i))), L.bottom + TIME_H / 2 + 1);
      }
      g.strokeStyle = C.sep; g.beginPath(); g.moveTo(plotR + 0.5, 0); g.lineTo(plotR + 0.5, L.bottom); g.stroke();

      drawDrawings(L);
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
      const c = cfg();
      if (c.bb.on) {   // 布林通道底色先畫
        const m = ind("bb");
        g.beginPath();
        let first = true;
        for (let i = i0; i <= i1; i++) if (Number.isFinite(m.up[i])) { if (first) { g.moveTo(xOf(i), yOf(m.up[i])); first = false; } else g.lineTo(xOf(i), yOf(m.up[i])); }
        for (let i = i1; i >= i0; i--) if (Number.isFinite(m.lo[i])) g.lineTo(xOf(i), yOf(m.lo[i]));
        g.closePath(); g.fillStyle = "rgba(92,157,237,0.08)"; g.fill();
      }
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
      if (c.bb.on) {
        const m = ind("bb");
        line(m.up, C.bb, i0, i1, xOf, yOf); line(m.lo, C.bb, i0, i1, xOf, yOf);
        g.setLineDash([4, 3]); line(m.mid, C.bb, i0, i1, xOf, yOf, 1); g.setLineDash([]);
      }
      if (c.ma.on) { const m = ind("ma"); line(m.a, C.ma[0], i0, i1, xOf, yOf); line(m.b, C.ma[1], i0, i1, xOf, yOf); line(m.c, C.ma[2], i0, i1, xOf, yOf); }
      if (c.ema.on) { const m = ind("ema"); line(m.a, C.ema[0], i0, i1, xOf, yOf); line(m.b, C.ema[1], i0, i1, xOf, yOf); }
      if (c.sar.on) {
        const m = ind("sar"), r = Math.max(1.2, Math.min(2.5, v.barW * 0.2));
        for (let i = i0; i <= i1; i++) if (Number.isFinite(m.sar[i])) {
          g.fillStyle = m.up[i] ? C.up : C.down;
          g.beginPath(); g.arc(xOf(i), yOf(m.sar[i]), r, 0, Math.PI * 2); g.fill();
        }
      }
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

    function axisLabel(text, y, bg) {
      g.fillStyle = bg; g.fillRect(layout.plotR + 1, y - 8, AXIS_W - 2, 16);
      g.fillStyle = "#fff"; g.textAlign = "left"; g.fillText(text, layout.plotR + 5, y);
    }

    function crosshair(L, bars, i) {
      const x = Math.round(L.xOf(i)) + 0.5, y = Math.round(mouse.y) + 0.5;
      g.strokeStyle = C.cross; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, L.bottom); g.moveTo(L.plotL, y); g.lineTo(L.plotR, y); g.stroke();
      g.setLineDash([]);
      const pane = L.panes.find(p => mouse.y >= p.top && mouse.y < p.top + p.h);
      if (pane && pane.valAt) {
        const val = pane.valAt(mouse.y);
        axisLabel(pane.id === "vol" || pane.id === "obv" ? fmtV(val) : fmtAuto(val), y, C.crossLabel);
      }
      const text = fmtTime(bars[i].t, period, true), w = g.measureText(text).width + 10;
      const bx = Math.max(0, Math.min(L.plotR - w, x - w / 2));
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
        g.font = "13px sans-serif";
        const w = g.measureText(d.text || "").width + 12;
        g.font = "11px sans-serif";
        out.box = [pts[0].x, pts[0].y - 11, w, 22];
      }
      return out;
    }

    function drawDrawings(L) {
      const pr = L.panes[0], list = drawings().slice();
      if (pending) list.push(pending);
      g.save();
      g.beginPath(); g.rect(L.plotL, pr.top, L.plotW, pr.h); g.clip();
      list.forEach((d, idx) => {
        const sel = d !== pending && idx === selected, G = geom(d, L), col = sel ? C.sel : C.draw;
        g.lineWidth = sel ? 2 : 1.4; g.strokeStyle = col;
        if (G.fill) { g.fillStyle = d.type === "rect" ? "rgba(255,176,0,0.10)" : "rgba(255,176,0,0.07)"; g.beginPath(); G.fill.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.fill(); }
        if (d.type === "fib") {
          G.levels.forEach((lv, k) => {
            if (k) { const prev = G.levels[k - 1]; g.fillStyle = lv.color + "14"; g.fillRect(lv.x1, Math.min(lv.y, prev.y), lv.x2 - lv.x1, Math.abs(lv.y - prev.y)); }
            g.strokeStyle = sel ? C.sel : lv.color; g.beginPath(); g.moveTo(lv.x1, lv.y); g.lineTo(lv.x2, lv.y); g.stroke();
            g.fillStyle = lv.color; g.textAlign = "left";
            g.fillText(`${lv.lv} (${fmtP(lv.p)})`, lv.x1 + 3, lv.y - 7);
          });
          g.strokeStyle = col; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(G.pts[0].x, G.pts[0].y); g.lineTo(G.pts[1].x, G.pts[1].y); g.stroke(); g.setLineDash([]);
        } else if (d.type === "text") {
          const [x, y, w, h] = G.box;
          g.fillStyle = "rgba(30,30,30,0.85)"; g.fillRect(x, y, w, h);
          g.strokeStyle = col; g.lineWidth = sel ? 2 : 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          g.font = "13px sans-serif"; g.fillStyle = C.draw; g.textAlign = "left"; g.fillText(d.text || "", x + 6, y + h / 2 + 1); g.font = "11px sans-serif";
        } else {
          g.beginPath(); for (const [p, q] of G.segs) { g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); } g.stroke();
          if (G.mid) { g.setLineDash([4, 4]); g.lineWidth = 1; g.beginPath(); g.moveTo(G.mid[0].x, G.mid[0].y); g.lineTo(G.mid[1].x, G.mid[1].y); g.stroke(); g.setLineDash([]); }
        }
        if (sel || d === pending) { g.fillStyle = col; for (const h of G.handles) { g.fillRect(h.x - 4, h.y - 4, 8, 8); g.strokeStyle = "#000"; g.lineWidth = 1; g.strokeRect(h.x - 4.5, h.y - 4.5, 9, 9); } }
      });
      g.restore(); g.lineWidth = 1;
      list.forEach((d, idx) => {
        if (d.type !== "hline") return;
        const y = pr.yOf(d.pts[0].p);
        if (y > pr.top + 8 && y < pr.top + pr.h - 8) axisLabel(fmtP(d.pts[0].p), y, idx === selected ? "#666" : "#8a6a00");
      });
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
    // 回傳 { idx, handle }；handle = 控制點索引，-1 = 整條
    function hitTest(p) {
      if (!layout) return null;
      const list = drawings();
      if (selected >= 0 && list[selected]) {
        const G = geom(list[selected], layout);
        const hk = G.handles.findIndex(h => Math.abs(h.x - p.x) <= 6 && Math.abs(h.y - p.y) <= 6);
        if (hk >= 0) return { idx: selected, handle: hk };
      }
      for (let k = list.length - 1; k >= 0; k--) {
        const G = geom(list[k], layout);
        if (G.segs.some(([a, b]) => distSeg(p, a, b) <= 6)) return { idx: k, handle: -1 };
        if (G.fill && inPoly(p, G.fill)) return { idx: k, handle: -1 };
        if (G.fillBox && p.x >= G.fillBox[0] && p.x <= G.fillBox[2] && p.y >= G.fillBox[1] && p.y <= G.fillBox[3]) return { idx: k, handle: -1 };
        if (G.box && p.x >= G.box[0] && p.x <= G.box[0] + G.box[2] && p.y >= G.box[1] && p.y <= G.box[1] + G.box[3]) return { idx: k, handle: -1 };
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
          selected = -1; save();
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
        if (hit) {
          selected = hit.idx;
          drag = { idx: hit.idx, handle: hit.handle, start: toAnchor(p), orig: clone(drawings()[hit.idx].pts), moved: false };
        } else { selected = -1; pan = { x: p.x, right: view().right }; }
      }
      sync(); requestRender();
    });
    canvas.addEventListener("dblclick", e => {
      const p = local(e), hit = layout && hitTest(p);
      if (hit && drawings()[hit.idx].type === "text") openText(p, hit.idx);
    });
    canvas.addEventListener("mousemove", e => {
      mouse = local(e);
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
      if (drag) { if (drag.moved) save(); drag = null; }
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
      if (e.key === "Escape") { pending = null; tool = "cursor"; selected = -1; closeMenus(); sync(); requestRender(); }
    });

    return {
      setQuote(q) {
        if (quote && quote.symbol === q.symbol) return;
        quote = q; loadEntry(); closeMenus(); sync(); render();
      },
      resize,
      render,
    };
  }

  window.XQChart = { create };
})();
