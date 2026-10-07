namespace WryFeedHost;

/// <summary>
/// Path-test generator: high-rate binary quotes/minutes over the real protocol.
/// Clearly labeled — NOT live SysJust / XQNext market data.
/// </summary>
sealed class DemoTicksBridge : IMarketBridge
{
    readonly object _gate = new();
    readonly Dictionary<string, QuoteState> _state = new(StringComparer.Ordinal);
    readonly Dictionary<string, string> _names = new(StringComparer.Ordinal)
    {
        ["2330"] = "台積電", ["2317"] = "鴻海", ["2454"] = "聯發科",
        ["2303"] = "聯電", ["2881"] = "富邦金", ["2882"] = "國泰金",
        ["AAPL"] = "Apple", ["TSLA"] = "Tesla", ["NVDA"] = "NVIDIA",
    };
    List<string> _symbols = new();
    string? _chart;
    CancellationTokenSource? _loopCts;
    Task? _loop;
        public string Name => "demo-ticks (NOT live SysJust data)";
    public bool IsReady => true;

    public event Action<IReadOnlyList<QuoteSnap>>? QuotesUpdated;
    public event Action<string, int, IReadOnlyList<Bar>>? IntradayReady;
    public event Action<string, IReadOnlyList<Bar>>? MinutesUpdated;
    public event Action<bool>? ReadyChanged
    {
        add { }
        remove { }
    }

    public Task SubscribeAsync(IReadOnlyList<string> symbols, string? chartSymbol, CancellationToken ct)
    {
        lock (_gate)
        {
            _symbols = symbols.Take(Protocol.MaxSymbols).Select(s => s.Trim()).Where(s => s.Length > 0).Distinct(StringComparer.Ordinal).ToList();
            _chart = string.IsNullOrWhiteSpace(chartSymbol) ? null : chartSymbol.Trim();
            foreach (var s in _symbols)
                EnsureState(s);
        }
        RestartLoop();
        // Snapshot intraday for chart symbol so UI can paint immediately
        if (!string.IsNullOrEmpty(_chart))
            PublishDemoIntraday(_chart);
        Console.WriteLine($"[DemoTicks] path-test subscribe n={_symbols.Count} chart={_chart ?? "-"} — synthetic, not live");
        return Task.CompletedTask;
    }

    public Task UnsubscribeAllAsync(CancellationToken ct)
    {
        StopLoop();
        lock (_gate)
        {
            _symbols = new();
            _chart = null;
        }
        Console.WriteLine("[DemoTicks] unsubscribed");
        return Task.CompletedTask;
    }

    void RestartLoop()
    {
        StopLoop();
        _loopCts = new CancellationTokenSource();
        var token = _loopCts.Token;
        _loop = Task.Run(() => LoopAsync(token), token);
    }

    void StopLoop()
    {
        try { _loopCts?.Cancel(); } catch { /* ignore */ }
        _loopCts?.Dispose();
        _loopCts = null;
        _loop = null;
    }

    async Task LoopAsync(CancellationToken ct)
    {
        var rng = new Random(42);
        // ~40 Hz quote batches; minutes every ~1s — coalesced by TcpServer flush
        var tick = 0;
        while (!ct.IsCancellationRequested)
        {
            List<string> syms;
            string? chart;
            lock (_gate) { syms = _symbols.ToList(); chart = _chart; }
            if (syms.Count == 0)
            {
                try { await Task.Delay(100, ct).ConfigureAwait(false); } catch { break; }
                continue;
            }

            var batch = new List<QuoteSnap>(syms.Count);
            lock (_gate)
            {
                foreach (var s in syms)
                {
                    var st = EnsureState(s);
                    var wobble = (rng.NextDouble() - 0.48) * Math.Max(0.5, st.Price * 0.0015);
                    st.Price = Math.Max(0.01, st.Price + wobble);
                    st.Volume += rng.Next(10, 400);
                    var change = st.Price - st.Prev;
                    batch.Add(new QuoteSnap(s, NameOf(s), ToCents(st.Price), ToCents(change), st.Volume));
                }
            }
            QuotesUpdated?.Invoke(batch);

            tick++;
            if (tick % 40 == 0 && !string.IsNullOrEmpty(chart))
            {
                lock (_gate)
                {
                    if (_state.TryGetValue(chart, out var st))
                    {
                        var t = MinuteOfDay();
                        var c = ToCents(st.Price);
                        var bar = new Bar(t, c, c + 5, c - 5, c, rng.Next(100, 5000));
                        MinutesUpdated?.Invoke(chart, new[] { bar });
                    }
                }
            }

            try { await Task.Delay(25, ct).ConfigureAwait(false); } catch { break; }
        }
    }

    void PublishDemoIntraday(string symbol)
    {
        QuoteState st;
        lock (_gate) st = EnsureState(symbol);
        var prev = ToCents(st.Prev);
        var bars = new List<Bar>(120);
        var basePx = st.Prev;
        var rng = new Random(symbol.GetHashCode());
        var start = (ushort)Math.Max(0, MinuteOfDay() - 120);
        for (int i = 0; i < 120; i++)
        {
            var t = (ushort)(start + i);
            var o = basePx + (rng.NextDouble() - 0.5) * 2;
            var c = o + (rng.NextDouble() - 0.5) * 2;
            var h = Math.Max(o, c) + rng.NextDouble();
            var l = Math.Min(o, c) - rng.NextDouble();
            bars.Add(new Bar(t, ToCents(o), ToCents(h), ToCents(l), ToCents(c), rng.Next(50, 3000)));
            basePx = c;
        }
        IntradayReady?.Invoke(symbol, prev, bars);
    }

    QuoteState EnsureState(string symbol)
    {
        if (_state.TryGetValue(symbol, out var st)) return st;
        var seed = Math.Abs(symbol.GetHashCode());
        var prev = 50 + (seed % 900);
        st = new QuoteState { Prev = prev, Price = prev, Volume = seed % 100000 };
        _state[symbol] = st;
        return st;
    }

    string NameOf(string symbol) => _names.TryGetValue(symbol, out var n) ? n : symbol;

    static int ToCents(double px) => (int)Math.Round(px * 100.0);
    static ushort MinuteOfDay()
    {
        var now = DateTime.Now;
        return (ushort)Math.Clamp(now.Hour * 60 + now.Minute, 0, 24 * 60 - 1);
    }

    public ValueTask DisposeAsync()
    {
        StopLoop();
        return ValueTask.CompletedTask;
    }

    sealed class QuoteState
    {
        public double Prev;
        public double Price;
        public long Volume;
    }
}
