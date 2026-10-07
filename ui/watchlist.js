/* XQ 組合／報價虛擬表：列+欄虛擬化、可見格增量更新、欄位上限 100 */
(() => {
  const MAX_COLS = 100;
  const ROW_H = 24;
  const DEFAULT_COL_W = 88;
  const OVERSCAN_ROWS = 6;
  const OVERSCAN_COLS = 2;

  const FIELD_DEFS = [
    { id: "symbol", label: "代號", kind: "sym", width: 72, align: "left", sticky: true },
    { id: "name", label: "名稱", kind: "name", width: 96, align: "left", sticky: true },
    { id: "price", label: "成交", kind: "num", width: 80, digits: 2, colorize: true },
    { id: "change", label: "漲跌", kind: "num", width: 72, digits: 2, colorize: true, signed: true },
    { id: "pct", label: "漲幅%", kind: "pct", width: 72, digits: 2, colorize: true, signed: true },
    { id: "volume", label: "成交量", kind: "int", width: 88 },
    { id: "bid", label: "買進", kind: "num", width: 72, digits: 2 },
    { id: "ask", label: "賣出", kind: "num", width: 72, digits: 2 },
    { id: "high", label: "最高", kind: "num", width: 72, digits: 2 },
    { id: "low", label: "最低", kind: "num", width: 72, digits: 2 },
    { id: "open", label: "開盤", kind: "num", width: 72, digits: 2 },
    { id: "prev", label: "昨收", kind: "num", width: 72, digits: 2 },
    { id: "turnover", label: "成交額", kind: "int", width: 96 },
    { id: "amp", label: "振幅%", kind: "pct", width: 72, digits: 2 },
    { id: "avg", label: "均價", kind: "num", width: 72, digits: 2 },
    { id: "bidVol", label: "買量", kind: "int", width: 72 },
    { id: "askVol", label: "賣量", kind: "int", width: 72 },
    { id: "tick", label: "Tick", kind: "int", width: 64 },
    { id: "time", label: "時間", kind: "time", width: 72 },
    { id: "status", label: "狀態", kind: "text", width: 64 },
  ];
  const FIELD_MAP = Object.fromEntries(FIELD_DEFS.map(f => [f.id, f]));

  function cloneCols(cols) {
    return (cols || []).map(c => ({
      id: c.id,
      field: c.field,
      label: c.label,
      width: Math.max(40, Math.min(320, c.width | 0 || DEFAULT_COL_W)),
    }));
  }

  function defaultColumns() {
    return [
      { id: "c-sym", field: "symbol", label: "代號", width: 72 },
      { id: "c-name", field: "name", label: "名稱", width: 96 },
      { id: "c-px", field: "price", label: "成交", width: 80 },
      { id: "c-ch", field: "change", label: "漲跌", width: 72 },
      { id: "c-pct", field: "pct", label: "漲幅%", width: 72 },
      { id: "c-vol", field: "volume", label: "成交量", width: 88 },
    ];
  }

  function ensureColumns(cols) {
    let list = Array.isArray(cols) ? cloneCols(cols) : defaultColumns();
    if (!list.length) list = defaultColumns();
    if (list.length > MAX_COLS) list = list.slice(0, MAX_COLS);
    list.forEach((c, i) => {
      if (!c.id) c.id = "c-" + i;
      if (!FIELD_MAP[c.field]) c.field = "price";
      if (!c.label) c.label = (FIELD_MAP[c.field] && FIELD_MAP[c.field].label) || c.field;
      c.width = Math.max(40, Math.min(320, c.width | 0 || DEFAULT_COL_W));
    });
    return list;
  }

  /** 合成 50k 假資料：平行陣列，不進 state.json */
  function makeSynthetic(count, seed) {
    count = Math.max(1, count | 0);
    seed = (seed | 0) || 1;
    const symbols = new Array(count);
    const names = new Array(count);
    const price = new Float64Array(count);
    const change = new Float64Array(count);
    const volume = new Float64Array(count);
    const bid = new Float64Array(count);
    const ask = new Float64Array(count);
    const high = new Float64Array(count);
    const low = new Float64Array(count);
    const open = new Float64Array(count);
    const prev = new Float64Array(count);
    const turnover = new Float64Array(count);
    const bidVol = new Float64Array(count);
    const askVol = new Float64Array(count);
    const tick = new Float64Array(count);
    const time = new Float64Array(count);
    const status = new Array(count);
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const namesPool = ["電子", "金融", "鋼鐵", "塑化", "航運", "生技", "營建", "觀光", "食品", "半導體", "面板", "光電", "電機", "汽車", "貿易"];
    for (let i = 0; i < count; i++) {
      const code = 1000 + ((i * 37 + seed) % 9000);
      symbols[i] = String(code);
      names[i] = namesPool[i % namesPool.length] + (i % 97);
      const base = 10 + rnd() * 2000;
      prev[i] = base;
      const ch = (rnd() - 0.48) * base * 0.04;
      change[i] = ch;
      price[i] = base + ch;
      open[i] = base + (rnd() - 0.5) * Math.abs(ch);
      high[i] = Math.max(price[i], open[i]) + rnd() * Math.abs(ch);
      low[i] = Math.min(price[i], open[i]) - rnd() * Math.abs(ch);
      volume[i] = Math.floor(rnd() * 5e6);
      turnover[i] = volume[i] * price[i];
      bid[i] = price[i] - rnd() * 2;
      ask[i] = price[i] + rnd() * 2;
      bidVol[i] = Math.floor(rnd() * 500);
      askVol[i] = Math.floor(rnd() * 500);
      tick[i] = Math.floor(rnd() * 10000);
      time[i] = 90000 + Math.floor(rnd() * 60000);
      status[i] = rnd() > 0.97 ? "注意" : "正常";
    }
    return {
      count, synthetic: true, seed,
      symbols, names, price, change, volume, bid, ask, high, low, open, prev,
      turnover, bidVol, askVol, tick, time, status,
    };
  }

  function makeFromSymbols(symList, quoteLookup) {
    const count = symList.length;
    const symbols = symList.slice();
    const names = new Array(count);
    const price = new Float64Array(count);
    const change = new Float64Array(count);
    const volume = new Float64Array(count);
    const bid = new Float64Array(count);
    const ask = new Float64Array(count);
    const high = new Float64Array(count);
    const low = new Float64Array(count);
    const open = new Float64Array(count);
    const prev = new Float64Array(count);
    const turnover = new Float64Array(count);
    const bidVol = new Float64Array(count);
    const askVol = new Float64Array(count);
    const tick = new Float64Array(count);
    const time = new Float64Array(count);
    const status = new Array(count);
    for (let i = 0; i < count; i++) {
      const q = quoteLookup(symbols[i]);
      symbols[i] = q.symbol;
      names[i] = q.name || q.symbol;
      price[i] = q.price;
      change[i] = q.change;
      prev[i] = q.price - q.change;
      open[i] = prev[i];
      high[i] = Math.max(price[i], prev[i]);
      low[i] = Math.min(price[i], prev[i]);
      volume[i] = 1000 + (i * 17) % 9000;
      turnover[i] = volume[i] * price[i];
      bid[i] = price[i] - 0.5;
      ask[i] = price[i] + 0.5;
      bidVol[i] = 10; askVol[i] = 10;
      tick[i] = i; time[i] = 130000; status[i] = "正常";
    }
    return {
      count, synthetic: false, seed: 0,
      symbols, names, price, change, volume, bid, ask, high, low, open, prev,
      turnover, bidVol, askVol, tick, time, status,
    };
  }

  function cellValue(data, field, row) {
    switch (field) {
      case "symbol": return data.symbols[row];
      case "name": return data.names[row];
      case "price": return data.price[row];
      case "change": return data.change[row];
      case "pct": {
        const p = data.prev[row];
        return p ? (data.change[row] / p) * 100 : 0;
      }
      case "volume": return data.volume[row];
      case "bid": return data.bid[row];
      case "ask": return data.ask[row];
      case "high": return data.high[row];
      case "low": return data.low[row];
      case "open": return data.open[row];
      case "prev": return data.prev[row];
      case "turnover": return data.turnover[row];
      case "amp": {
        const p = data.prev[row];
        return p ? ((data.high[row] - data.low[row]) / p) * 100 : 0;
      }
      case "avg": return data.volume[row] ? data.turnover[row] / data.volume[row] : data.price[row];
      case "bidVol": return data.bidVol[row];
      case "askVol": return data.askVol[row];
      case "tick": return data.tick[row];
      case "time": return data.time[row];
      case "status": return data.status[row];
      default: return data.price[row];
    }
  }

  function fmtCell(field, val) {
    const def = FIELD_MAP[field] || FIELD_DEFS[2];
    if (val == null) return "";
    if (def.kind === "sym" || def.kind === "name" || def.kind === "text") return String(val);
    if (def.kind === "time") {
      const n = val | 0;
      const h = Math.floor(n / 10000), m = Math.floor((n % 10000) / 100), s = n % 100;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    if (def.kind === "int") {
      const n = Math.round(+val);
      if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + "億";
      if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + "萬";
      return n.toLocaleString("zh-TW");
    }
    const d = def.digits != null ? def.digits : 2;
    const n = +val;
    if (!Number.isFinite(n)) return "";
    const sign = def.signed && n > 0 ? "+" : "";
    return sign + n.toFixed(d) + (def.kind === "pct" ? "%" : "");
  }

  function colorClass(field, data, row) {
    const def = FIELD_MAP[field];
    if (!def || !def.colorize) return "";
    const ch = data.change[row];
    return ch > 0 ? "up" : ch < 0 ? "down" : "";
  }

  function create(root, opts) {
    opts = opts || {};
    const onSave = typeof opts.onSave === "function" ? opts.onSave : () => {};
    const onSelect = typeof opts.onSelect === "function" ? opts.onSelect : () => {};
    const quoteLookup = typeof opts.quoteLookup === "function"
      ? opts.quoteLookup
      : (s) => ({ symbol: s, name: s, price: 100, change: 0 });

    root.classList.add("xq-wl");
    root.innerHTML = `
      <div class="xq-wl-toolbar">
        <select class="xq-wl-groups" title="組合"></select>
        <button type="button" class="xq-wl-btn" data-act="add-sym" title="加入代號">＋代號</button>
        <button type="button" class="xq-wl-btn" data-act="edit-sym" title="編輯代號">代號</button>
        <button type="button" class="xq-wl-btn" data-act="edit-col" title="編輯欄位">欄位</button>
        <button type="button" class="xq-wl-btn" data-act="stress" title="載入 5 萬檔壓力組合">5萬</button>
        <span class="xq-wl-meta"></span>
      </div>
      <div class="xq-wl-head"><div class="xq-wl-head-inner"></div></div>
      <div class="xq-wl-body">
        <div class="xq-wl-spacer"></div>
        <div class="xq-wl-rows"></div>
      </div>
      <div class="xq-wl-dialog" hidden></div>
    `;
    const elGroups = root.querySelector(".xq-wl-groups");
    const elMeta = root.querySelector(".xq-wl-meta");
    const elHead = root.querySelector(".xq-wl-head");
    const elHeadInner = root.querySelector(".xq-wl-head-inner");
    const elBody = root.querySelector(".xq-wl-body");
    const elSpacer = root.querySelector(".xq-wl-spacer");
    const elRows = root.querySelector(".xq-wl-rows");
    const elDialog = root.querySelector(".xq-wl-dialog");

    let columns = ensureColumns(opts.columns);
    let groupsMeta = []; // {id,name,synthetic?,count?,seed?,symbols?}
    let activeId = null;
    let data = makeSynthetic(0, 1);
    let selectedRow = -1;
    let scrollTop = 0, scrollLeft = 0;
    let viewportH = 200, viewportW = 400;
    let dirtyRows = new Set();
    let paintScheduled = false;
    let tickTimer = 0;
    let ticking = false;
    let tickRate = 0; // updates per second target
    let metrics = { paints: 0, cellUpdates: 0, lastPaintMs: 0, scrollEvents: 0, jankMs: 0, jankN: 0 };
    let lastScrollTs = 0;
    let resizeCol = null;

    function persistShape() {
      onSave({
        columns: cloneCols(columns),
        activeGroupId: activeId,
        groups: groupsMeta.map(g => {
          if (g.synthetic) {
            return { id: g.id, name: g.name, synthetic: true, count: g.count, seed: g.seed };
          }
          return { id: g.id, name: g.name, symbols: (g.symbols || []).slice() };
        }),
      });
    }

    function totalWidth() {
      let w = 0;
      for (let i = 0; i < columns.length; i++) w += columns[i].width;
      return w;
    }

    function colOffsets() {
      const off = new Array(columns.length + 1);
      off[0] = 0;
      for (let i = 0; i < columns.length; i++) off[i + 1] = off[i] + columns[i].width;
      return off;
    }

    function visibleRange() {
      const rowCount = data.count;
      const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN_ROWS);
      const visible = Math.ceil(viewportH / ROW_H) + OVERSCAN_ROWS * 2;
      const last = Math.min(rowCount, first + visible);
      const offs = colOffsets();
      const tw = offs[offs.length - 1] || 0;
      let c0 = 0, c1 = columns.length;
      while (c0 < columns.length - 1 && offs[c0 + 1] < scrollLeft) c0++;
      c0 = Math.max(0, c0 - OVERSCAN_COLS);
      c1 = c0;
      while (c1 < columns.length && offs[c1] < scrollLeft + viewportW) c1++;
      c1 = Math.min(columns.length, c1 + OVERSCAN_COLS);
      return { first, last, c0, c1, offs, tw };
    }

    function renderHeader() {
      const { c0, c1, offs, tw } = visibleRange();
      elHeadInner.style.width = tw + "px";
      elHeadInner.style.transform = `translateX(${-scrollLeft}px)`;
      let html = "";
      for (let c = c0; c < c1; c++) {
        const col = columns[c];
        html += `<div class="xq-wl-th" data-ci="${c}" style="left:${offs[c]}px;width:${col.width}px">${escapeHtml(col.label)}<i class="xq-wl-resize" data-ci="${c}"></i></div>`;
      }
      elHeadInner.innerHTML = html;
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    function paintRows(force) {
      const t0 = performance.now();
      const { first, last, c0, c1, offs, tw } = visibleRange();
      elSpacer.style.height = (data.count * ROW_H) + "px";
      elRows.style.width = tw + "px";

      // reuse row nodes
      const need = Math.max(0, last - first);
      while (elRows.children.length > need) elRows.removeChild(elRows.lastChild);
      while (elRows.children.length < need) {
        const row = document.createElement("div");
        row.className = "xq-wl-row";
        elRows.appendChild(row);
      }

      let cellsTouched = 0;
      for (let i = 0; i < need; i++) {
        const rowIdx = first + i;
        const rowEl = elRows.children[i];
        const wasDirty = dirtyRows.has(rowIdx);
        if (!force && !wasDirty && rowEl.dataset.ri === String(rowIdx) && rowEl.dataset.c0 === String(c0) && rowEl.dataset.c1 === String(c1)) {
          continue;
        }
        rowEl.dataset.ri = String(rowIdx);
        rowEl.dataset.c0 = String(c0);
        rowEl.dataset.c1 = String(c1);
        rowEl.style.transform = `translateY(${rowIdx * ROW_H}px)`;
        rowEl.classList.toggle("sel", rowIdx === selectedRow);
        let html = "";
        for (let c = c0; c < c1; c++) {
          const col = columns[c];
          const def = FIELD_MAP[col.field];
          const cls = colorClass(col.field, data, rowIdx);
          const align = (def && def.align === "left") ? " left" : "";
          const text = fmtCell(col.field, cellValue(data, col.field, rowIdx));
          html += `<div class="xq-wl-td${align}${cls ? " " + cls : ""}" data-ci="${c}" style="left:${offs[c]}px;width:${col.width}px">${escapeHtml(text)}</div>`;
          cellsTouched++;
        }
        rowEl.innerHTML = html;
        dirtyRows.delete(rowIdx);
      }
      // clear dirty outside viewport cheaply
      if (dirtyRows.size > 2000) dirtyRows.clear();
      else {
        for (const r of [...dirtyRows]) {
          if (r < first || r >= last) dirtyRows.delete(r);
        }
      }
      renderHeader();
      elMeta.textContent = `${data.count.toLocaleString("zh-TW")} 檔 · ${columns.length} 欄`;
      metrics.paints++;
      metrics.cellUpdates += cellsTouched;
      metrics.lastPaintMs = performance.now() - t0;
      paintScheduled = false;
    }

    function schedulePaint(force) {
      if (force) {
        if (!paintScheduled) paintScheduled = true;
        requestAnimationFrame(() => paintRows(true));
        return;
      }
      if (paintScheduled) return;
      paintScheduled = true;
      requestAnimationFrame(() => paintRows(false));
    }

    function loadGroup(g) {
      activeId = g.id;
      if (g.synthetic) {
        data = makeSynthetic(g.count || 50000, g.seed || 1);
      } else {
        data = makeFromSymbols(g.symbols || [], quoteLookup);
      }
      dirtyRows.clear();
      selectedRow = -1;
      elBody.scrollTop = 0;
      scrollTop = 0;
      schedulePaint(true);
      refreshGroupSelect();
      persistShape();
    }

    function refreshGroupSelect() {
      elGroups.innerHTML = "";
      groupsMeta.forEach(g => {
        const o = document.createElement("option");
        o.value = g.id;
        o.textContent = g.name + (g.synthetic ? ` (${(g.count || 0).toLocaleString("zh-TW")})` : ` (${(g.symbols || []).length})`);
        if (g.id === activeId) o.selected = true;
        elGroups.appendChild(o);
      });
    }

    function setState(state) {
      state = state || {};
      columns = ensureColumns(state.columns);
      groupsMeta = Array.isArray(state.groups) && state.groups.length
        ? state.groups.map(g => ({
            id: g.id || ("g-" + Math.random().toString(36).slice(2, 7)),
            name: g.name || "組合",
            synthetic: !!g.synthetic,
            count: g.count | 0,
            seed: g.seed | 0,
            symbols: Array.isArray(g.symbols) ? g.symbols.slice() : [],
          }))
        : [
            { id: "g-watch", name: "自選", symbols: (opts.initialSymbols || ["2330", "2317"]).slice() },
            { id: "g-stress", name: "壓力 5萬", synthetic: true, count: 50000, seed: 42 },
          ];
      activeId = state.activeGroupId || groupsMeta[0].id;
      const g = groupsMeta.find(x => x.id === activeId) || groupsMeta[0];
      loadGroup(g);
    }

    function measure() {
      viewportH = elBody.clientHeight || 200;
      viewportW = elBody.clientWidth || 400;
    }

    elBody.addEventListener("scroll", () => {
      const now = performance.now();
      if (lastScrollTs) {
        const dt = now - lastScrollTs;
        if (dt > 32) { metrics.jankMs += dt; metrics.jankN++; }
      }
      lastScrollTs = now;
      metrics.scrollEvents++;
      scrollTop = elBody.scrollTop;
      scrollLeft = elBody.scrollLeft;
      elHead.scrollLeft = scrollLeft;
      schedulePaint(true);
    }, { passive: true });

    elRows.addEventListener("click", e => {
      const rowEl = e.target.closest(".xq-wl-row");
      if (!rowEl) return;
      const ri = +rowEl.dataset.ri;
      if (!Number.isFinite(ri)) return;
      selectedRow = ri;
      schedulePaint(true);
      onSelect({ symbol: data.symbols[ri], name: data.names[ri], row: ri });
    });

    elHeadInner.addEventListener("mousedown", e => {
      const handle = e.target.closest(".xq-wl-resize");
      if (!handle) return;
      e.preventDefault();
      const ci = +handle.dataset.ci;
      resizeCol = { ci, startX: e.clientX, startW: columns[ci].width };
      document.body.classList.add("xq-wl-resizing");
    });
    window.addEventListener("mousemove", e => {
      if (!resizeCol) return;
      const dx = e.clientX - resizeCol.startX;
      columns[resizeCol.ci].width = Math.max(40, Math.min(320, resizeCol.startW + dx));
      schedulePaint(true);
    });
    window.addEventListener("mouseup", () => {
      if (!resizeCol) return;
      resizeCol = null;
      document.body.classList.remove("xq-wl-resizing");
      persistShape();
    });

    elGroups.addEventListener("change", () => {
      const g = groupsMeta.find(x => x.id === elGroups.value);
      if (g) loadGroup(g);
    });

    root.querySelector('[data-act="stress"]').addEventListener("click", () => {
      let g = groupsMeta.find(x => x.synthetic && x.count >= 50000);
      if (!g) {
        g = { id: "g-stress", name: "壓力 5萬", synthetic: true, count: 50000, seed: 42 };
        groupsMeta.push(g);
      }
      loadGroup(g);
    });

    root.querySelector('[data-act="add-sym"]').addEventListener("click", () => {
      const g = groupsMeta.find(x => x.id === activeId);
      if (!g || g.synthetic) {
        openDialog("合成組合請先複製為可編輯組合，或選「自選」。", null);
        return;
      }
      openDialog("加入代號（逗號或空白分隔）", (text) => {
        const parts = text.toUpperCase().split(/[\s,;]+/).filter(Boolean);
        let n = 0;
        parts.forEach(s => {
          if (!/^[A-Z0-9]{4,6}$/.test(s)) return;
          if (!g.symbols.includes(s)) { g.symbols.push(s); n++; }
        });
        if (n) loadGroup(g);
      }, "");
    });

    root.querySelector('[data-act="edit-sym"]').addEventListener("click", () => openSymbolEditor());
    root.querySelector('[data-act="edit-col"]').addEventListener("click", () => openColumnEditor());

    function openDialog(title, onOk, initial) {
      elDialog.hidden = false;
      elDialog.innerHTML = `
        <div class="xq-wl-dlg">
          <div class="xq-wl-dlg-title">${escapeHtml(title)}</div>
          ${onOk ? `<textarea class="xq-wl-dlg-ta">${escapeHtml(initial || "")}</textarea>
            <div class="xq-wl-dlg-actions">
              <button type="button" data-ok>確定</button>
              <button type="button" data-cancel>取消</button>
            </div>` : `<div class="xq-wl-dlg-actions"><button type="button" data-cancel>關閉</button></div>`}
        </div>`;
      elDialog.querySelector("[data-cancel]").onclick = () => { elDialog.hidden = true; };
      const ok = elDialog.querySelector("[data-ok]");
      if (ok) ok.onclick = () => {
        const ta = elDialog.querySelector(".xq-wl-dlg-ta");
        elDialog.hidden = true;
        onOk(ta.value);
      };
    }

    function openSymbolEditor() {
      const g = groupsMeta.find(x => x.id === activeId);
      if (!g) return;
      if (g.synthetic) {
        // clone first 200 for edit demo + option to keep synthetic
        openDialog(
          `「${g.name}」為合成 ${g.count} 檔。輸入要保留編輯的代號（預設前 20 檔），將另存為可編輯組合：`,
          (text) => {
            let syms = text.split(/[\s,;]+/).filter(Boolean);
            if (!syms.length) syms = data.symbols.slice(0, 20);
            const ng = {
              id: "g-edit-" + Date.now().toString(36),
              name: g.name + "（可編輯）",
              symbols: syms,
            };
            groupsMeta.push(ng);
            loadGroup(ng);
          },
          data.symbols.slice(0, 20).join("\n")
        );
        return;
      }
      openDialog("編輯代號（每行一檔；可刪除／重排）", (text) => {
        const syms = text.toUpperCase().split(/[\s,;]+/).filter(s => /^[A-Z0-9]{4,6}$/.test(s));
        // unique preserve order
        const seen = new Set();
        g.symbols = syms.filter(s => (seen.has(s) ? false : (seen.add(s), true)));
        loadGroup(g);
      }, (g.symbols || []).join("\n"));
    }

    function openColumnEditor() {
      const catalog = FIELD_DEFS.map(f => `${f.id}\t${f.label}`).join("\n");
      const cur = columns.map(c => `${c.field}\t${c.label}\t${c.width}`).join("\n");
      elDialog.hidden = false;
      elDialog.innerHTML = `
        <div class="xq-wl-dlg xq-wl-dlg-wide">
          <div class="xq-wl-dlg-title">編輯欄位（上限 ${MAX_COLS}；格式：field\\t標題\\t寬度）</div>
          <div class="xq-wl-dlg-hint">可用欄位：${FIELD_DEFS.map(f => f.id).join(", ")}</div>
          <textarea class="xq-wl-dlg-ta" style="height:180px">${escapeHtml(cur)}</textarea>
          <div class="xq-wl-dlg-actions">
            <button type="button" data-add-all>填滿至 ${Math.min(MAX_COLS, FIELD_DEFS.length + 80)} 欄</button>
            <button type="button" data-ok>套用</button>
            <button type="button" data-cancel>取消</button>
          </div>
          <pre class="xq-wl-dlg-hint" style="max-height:80px;overflow:auto;opacity:.7">${escapeHtml(catalog)}</pre>
        </div>`;
      elDialog.querySelector("[data-cancel]").onclick = () => { elDialog.hidden = true; };
      elDialog.querySelector("[data-add-all]").onclick = () => {
        const ta = elDialog.querySelector(".xq-wl-dlg-ta");
        const lines = [];
        for (let i = 0; i < MAX_COLS; i++) {
          const f = FIELD_DEFS[i % FIELD_DEFS.length];
          lines.push(`${f.id}\t${f.label}${i >= FIELD_DEFS.length ? " " + (Math.floor(i / FIELD_DEFS.length) + 1) : ""}\t${f.width || DEFAULT_COL_W}`);
        }
        ta.value = lines.join("\n");
      };
      elDialog.querySelector("[data-ok]").onclick = () => {
        const ta = elDialog.querySelector(".xq-wl-dlg-ta");
        const next = [];
        ta.value.split("\n").forEach((line, i) => {
          if (next.length >= MAX_COLS) return;
          const parts = line.split("\t");
          if (!parts[0] || !parts[0].trim()) return;
          const field = parts[0].trim();
          if (!FIELD_MAP[field]) return;
          next.push({
            id: "c-" + i + "-" + field,
            field,
            label: (parts[1] && parts[1].trim()) || FIELD_MAP[field].label,
            width: Math.max(40, Math.min(320, parseInt(parts[2], 10) || FIELD_MAP[field].width || DEFAULT_COL_W)),
          });
        });
        if (next.length) {
          columns = ensureColumns(next);
          persistShape();
          schedulePaint(true);
        }
        elDialog.hidden = true;
      };
    }

    /** engine 報價：只改對到的列，可見列排進 dirty。合成壓測表不覆寫。 */
    function applyEngineQuotes(rows) {
      if (!data || data.synthetic || !rows || data.count > 8000) return 0;
      let n = 0;
      for (let r = 0; r < rows.length; r++) {
        const q = rows[r];
        if (!q || !q.symbol) continue;
        for (let i = 0; i < data.count; i++) {
          if (data.symbols[i] !== q.symbol) continue;
          data.price[i] = q.price;
          data.change[i] = q.change;
          data.prev[i] = q.price - q.change;
          if (q.price > data.high[i]) data.high[i] = q.price;
          if (q.price < data.low[i] || data.low[i] === 0) data.low[i] = q.price;
          if (Number.isFinite(q.volume)) {
            data.volume[i] = q.volume;
            data.turnover[i] = q.volume * q.price;
          }
          if (q.name) data.names[i] = q.name;
          dirtyRows.add(i);
          n++;
          break;
        }
      }
      if (n) schedulePaint(false);
      return n;
    }

    /** 高頻 tick：只改資料陣列，可見列排進 dirty → rAF 增量上色 */
    function applyTicks(n) {
      n = Math.max(1, n | 0);
      const count = data.count;
      if (!count) return;
      for (let k = 0; k < n; k++) {
        const i = (Math.random() * count) | 0;
        const wobble = (Math.random() - 0.5) * Math.max(0.2, Math.abs(data.price[i]) * 0.002);
        data.price[i] += wobble;
        data.change[i] = data.price[i] - data.prev[i];
        if (data.price[i] > data.high[i]) data.high[i] = data.price[i];
        if (data.price[i] < data.low[i]) data.low[i] = data.price[i];
        data.volume[i] += (Math.random() * 200) | 0;
        data.turnover[i] = data.volume[i] * data.price[i];
        data.bid[i] = data.price[i] - Math.random();
        data.ask[i] = data.price[i] + Math.random();
        data.tick[i] += 1;
        data.time[i] = ((data.time[i] | 0) + 1) % 240000;
        dirtyRows.add(i);
      }
      schedulePaint(false);
    }

    function startTicks(hz) {
      stopTicks();
      tickRate = Math.max(0, hz | 0);
      if (!tickRate) return;
      ticking = true;
      const batch = Math.max(1, Math.round(tickRate / 30));
      tickTimer = setInterval(() => {
        if (!ticking) return;
        applyTicks(batch);
      }, 1000 / 30);
    }
    function stopTicks() {
      ticking = false;
      if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
    }

    const ro = new ResizeObserver(() => {
      measure();
      schedulePaint(true);
    });
    ro.observe(root);

    function getMetrics() {
      return {
        rows: data.count,
        cols: columns.length,
        paints: metrics.paints,
        cellUpdates: metrics.cellUpdates,
        lastPaintMs: +metrics.lastPaintMs.toFixed(2),
        scrollEvents: metrics.scrollEvents,
        jankCount: metrics.jankN,
        jankAvgMs: metrics.jankN ? +(metrics.jankMs / metrics.jankN).toFixed(1) : 0,
        tickRate,
        selected: selectedRow,
      };
    }

    function resetMetrics() {
      metrics = { paints: 0, cellUpdates: 0, lastPaintMs: 0, scrollEvents: 0, jankMs: 0, jankN: 0 };
    }

    async function bench(opts2) {
      opts2 = opts2 || {};
      const report = typeof opts2.report === "function" ? opts2.report : () => {};
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      resetMetrics();
      // ensure 50k
      let g = groupsMeta.find(x => x.synthetic && (x.count || 0) >= (opts2.rows || 50000));
      if (!g) {
        g = { id: "g-stress", name: "壓力 5萬", synthetic: true, count: opts2.rows || 50000, seed: 42 };
        groupsMeta.push(g);
      } else {
        g.count = opts2.rows || g.count || 50000;
      }
      // fill columns toward cap
      if ((opts2.cols || 40) > columns.length) {
        const next = cloneCols(columns);
        while (next.length < Math.min(MAX_COLS, opts2.cols || 40)) {
          const f = FIELD_DEFS[next.length % FIELD_DEFS.length];
          next.push({
            id: "c-b-" + next.length,
            field: f.id,
            label: f.label + (next.length >= FIELD_DEFS.length ? " " + (1 + Math.floor(next.length / FIELD_DEFS.length)) : ""),
            width: f.width || DEFAULT_COL_W,
          });
        }
        columns = ensureColumns(next);
        persistShape();
      }
      loadGroup(g);
      await sleep(100);
      measure();
      schedulePaint(true);
      await sleep(50);

      const hz = opts2.tickHz || 2000;
      startTicks(hz);
      report({ phase: "tick-start", rows: data.count, cols: columns.length, tickHz: hz });

      // measure FPS via rAF while ticking
      let frames = 0;
      const t0 = performance.now();
      await new Promise(resolve => {
        const end = t0 + (opts2.tickMs || 2000);
        function beat(now) {
          frames++;
          if (now >= end) resolve();
          else requestAnimationFrame(beat);
        }
        requestAnimationFrame(beat);
      });
      const tickElapsed = performance.now() - t0;
      const tickFps = (frames * 1000) / tickElapsed;
      const afterTick = getMetrics();
      report({ phase: "tick-end", fps: +tickFps.toFixed(1), elapsedMs: +tickElapsed.toFixed(0), ...afterTick });

      // scroll stress
      resetMetrics();
      const scrollMs = opts2.scrollMs || 2000;
      const s0 = performance.now();
      let sFrames = 0;
      const maxScroll = Math.max(0, data.count * ROW_H - viewportH);
      await new Promise(resolve => {
        const end = s0 + scrollMs;
        function beat(now) {
          sFrames++;
          const t = (now - s0) / scrollMs;
          elBody.scrollTop = (Math.sin(t * Math.PI * 4) * 0.5 + 0.5) * maxScroll;
          elBody.scrollLeft = (Math.sin(t * Math.PI * 3) * 0.5 + 0.5) * Math.max(0, totalWidth() - viewportW);
          if (now >= end) resolve();
          else requestAnimationFrame(beat);
        }
        requestAnimationFrame(beat);
      });
      const scrollElapsed = performance.now() - s0;
      const scrollFps = (sFrames * 1000) / scrollElapsed;
      const afterScroll = getMetrics();
      stopTicks();
      report({
        phase: "done",
        rows: data.count,
        cols: columns.length,
        maxCols: MAX_COLS,
        tickFps: +tickFps.toFixed(1),
        scrollFps: +scrollFps.toFixed(1),
        scrollJankCount: afterScroll.jankCount,
        scrollJankAvgMs: afterScroll.jankAvgMs,
        lastPaintMs: afterScroll.lastPaintMs,
        cellUpdates: afterScroll.cellUpdates,
        note: "virtualized rows+cols; incremental visible cells; synthetic not persisted",
      });
      return { tickFps, scrollFps, afterTick, afterScroll };
    }

    // init
    measure();
    setState(opts.state || null);

    return {
      MAX_COLS,
      setState,
      getState: () => ({
        columns: cloneCols(columns),
        activeGroupId: activeId,
        groups: groupsMeta.map(g => g.synthetic
          ? { id: g.id, name: g.name, synthetic: true, count: g.count, seed: g.seed }
          : { id: g.id, name: g.name, symbols: (g.symbols || []).slice() }),
      }),
      reload: () => schedulePaint(true),
      applyEngineQuotes,
      applyTicks,
      startTicks,
      stopTicks,
      bench,
      getMetrics,
      resize: () => { measure(); schedulePaint(true); },
    };
  }

  window.XQWatchlist = { create, MAX_COLS, FIELD_DEFS, defaultColumns, ensureColumns };
})();
