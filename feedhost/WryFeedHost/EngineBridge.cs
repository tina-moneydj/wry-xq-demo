namespace WryFeedHost;

/// <summary>
/// Best-effort bridge to XQNext DAQEngine.
///
/// Real Windows flow (see DAQEngine.Client):
///   1. Spawn <c>DAQEngine\XQNextEngine.exe</c> with
///      <c>DAQEngineStartArgument</c>: <c>{AppId} {LogLevel} {LogEncrypt} {LogPeriod} {PipeName} {LogCleanCheck} {UseWinINet}</c>
///      e.g. <c>XQNext 1 0 0  0 0</c> → pipe <c>\\.\Pipe\DAQEngine\XQNext\Port</c>
///      (<c>GetFullPipeName</c> = <c>\DAQEngine\{AppId}{PipeName}\Port</c>).
///   2. <c>IDAQEngineProcess.GetPortAsync</c> reads the TCP port text from that named pipe
///      (also HttpPort variant).
///   3. Connect localhost framed TCP (FrameStart=0x02, End1=0x03, End2=0x04, 8-byte header)
///      via DAQEngine.Client socket / <c>DAQEngineCommMgr</c>.
///   4. Login with SysJust token (loginuat.xq.com.tw / production host). <b>No live data without creds.</b>
///   5. RT path: <c>RTClient</c> Init → SetAuth → SetExch → Connect, then
///      <see cref="ReqHints.RT_RefQuote2"/> / <see cref="ReqHints.RT_AddTick2"/>;
///      responses <see cref="ResHints.RTData"/> / <see cref="ResHints.RTQuoteTickListNotify"/>.
///   6. Minute bars: request KData_* → <see cref="ResHints.KData_Min"/>.
///   7. FieldPool: <c>ProviderType.FieldPoolSvc</c> via ProviderSvc / CommMgr.
///
/// Package hint: <c>XQData.DAQEngine.Client</c> 0.43.0 (or local <c>%XQNEXT_HOME%\DAQEngine.Client.dll</c>).
/// Wine: engine process may stay up but named pipes NEVER appear — do not rely on Wine for live feed.
/// This stub keeps hello.ready=0 until a real login path is wired with credentials.
/// </summary>
sealed class EngineBridge : IMarketBridge
{
    readonly object _gate = new();
    List<string> _symbols = new();
    string? _chart;
    int _ready;

    public string Name => "engine-stub";
    public bool IsReady => Volatile.Read(ref _ready) != 0;

    public event Action<IReadOnlyList<QuoteSnap>>? QuotesUpdated;
    public event Action<string, int, IReadOnlyList<Bar>>? IntradayReady;
    public event Action<string, IReadOnlyList<Bar>>? MinutesUpdated;
    public event Action<bool>? ReadyChanged;

    public Task SubscribeAsync(IReadOnlyList<string> symbols, string? chartSymbol, CancellationToken ct)
    {
        lock (_gate)
        {
            _symbols = symbols.Take(Protocol.MaxSymbols).Select(s => s.Trim()).Where(s => s.Length > 0).Distinct(StringComparer.Ordinal).ToList();
            _chart = string.IsNullOrWhiteSpace(chartSymbol) ? null : chartSymbol.Trim();
        }

        // TODO(live): after login + RT Connect, send RT_RefQuote2 for _symbols and RT_AddTick2 / KData_Min for _chart.
        // ReqType.RT_RefQuote2 = 429, RT_UnRefQuote2 = 430, RT_AddTick2 = 431, KData_Count/SD = 201/200
        // ResType.RTData = 2201, RTQuoteTickListNotify = 2204, KData_Min = 2001, KData_Tick = 2000
        Console.WriteLine($"[EngineBridge] subscribe queued n={_symbols.Count} chart={_chart ?? "-"} (ready={IsReady}; waiting for SysJust login/FieldPool)");
        return Task.CompletedTask;
    }

    public Task UnsubscribeAllAsync(CancellationToken ct)
    {
        lock (_gate)
        {
            // TODO(live): RT_UnRefQuote2 / RT_RemoveTick2 / drop FieldPool view
            _symbols = new();
            _chart = null;
        }
        Console.WriteLine("[EngineBridge] unsubscribed");
        return Task.CompletedTask;
    }

    /// <summary>Call from a future login completion handler once FieldPool/RT is up.</summary>
    public void SetReady(bool ready)
    {
        var v = ready ? 1 : 0;
        if (Interlocked.Exchange(ref _ready, v) == v) return;
        ReadyChanged?.Invoke(ready);
    }

    // Hooks for a future RT callback mapper — keep signatures ready so TCP path stays cold.
    public void PublishQuotes(IReadOnlyList<QuoteSnap> quotes) => QuotesUpdated?.Invoke(quotes);
    public void PublishIntraday(string symbol, int prevCents, IReadOnlyList<Bar> bars) => IntradayReady?.Invoke(symbol, prevCents, bars);
    public void PublishMinutes(string symbol, IReadOnlyList<Bar> bars) => MinutesUpdated?.Invoke(symbol, bars);

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

/// <summary>Numeric mirrors of DAQEngine.Client.External.ReqType (avoid DLL ref on Linux CI).</summary>
static class ReqHints
{
    public const int Login = 0;
    public const int LoginAllServices = 10;
    public const int KData_SD = 200;
    public const int KData_Count = 201;
    public const int RT_Init = 400;
    public const int RT_Connect = 401;
    public const int RT_RefQuote = 413;
    public const int RT_UnRefQuote = 414;
    public const int RT_RefQuote2 = 429;
    public const int RT_UnRefQuote2 = 430;
    public const int RT_AddTick2 = 431;
    public const int RT_RemoveTick2 = 432;
    public const int ProviderSvc = 1200;
}

/// <summary>Numeric mirrors of DAQEngine.Client.External.ResType.</summary>
static class ResHints
{
    public const int LoginProgress = 1803;
    public const int KData_Tick = 2000;
    public const int KData_Min = 2001;
    public const int KData_DWM = 2002;
    public const int RTData = 2201;
    public const int RTQuoteTickListNotify = 2204;
    public const int ProviderSvc_Res = 3400;
}
