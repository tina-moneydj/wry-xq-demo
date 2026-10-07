using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace WryFeedHost;

/// <summary>
/// Single-client (latest wins) TCP host on 127.0.0.1:47631.
/// Coalesces quote updates per flush interval; drops stale per-symbol snapshots.
/// </summary>
sealed class TcpServer : IAsyncDisposable
{
    readonly IMarketBridge _bridge;
    readonly int _flushMs;
    TcpListener? _listener;
    CancellationTokenSource? _cts;
    Task? _acceptLoop;

    // latest session — wry-xq-demo reconnects; keep one active publisher
    volatile ClientSession? _session;

    public TcpServer(IMarketBridge bridge, int flushMs = 25)
    {
        _bridge = bridge;
        _flushMs = Math.Clamp(flushMs, 8, 100);
    }

    public async Task StartAsync(CancellationToken ct = default)
    {
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _listener = new TcpListener(IPAddress.Loopback, Protocol.Port);
        _listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        _listener.Start(4);
        Console.WriteLine($"[WryFeedHost] listening 127.0.0.1:{Protocol.Port} flush={_flushMs}ms bridge={_bridge.Name}");
        _acceptLoop = AcceptLoopAsync(_cts.Token);
        await Task.CompletedTask.ConfigureAwait(false);
    }

    async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener!.AcceptTcpClientAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { break; }
            catch (ObjectDisposedException) { break; }

            client.NoDelay = true;
            client.ReceiveBufferSize = 64 * 1024;
            client.SendBufferSize = 256 * 1024;
            var old = Interlocked.Exchange(ref _session, null);
            if (old is not null) await old.DisposeAsync().ConfigureAwait(false);

            var session = new ClientSession(client, _bridge, _flushMs);
            _session = session;
            _ = session.RunAsync(ct).ContinueWith(async t =>
            {
                if (t.IsFaulted) Console.Error.WriteLine($"[WryFeedHost] session fault: {t.Exception?.GetBaseException().Message}");
                if (ReferenceEquals(_session, session))
                    Interlocked.CompareExchange(ref _session, null, session);
                await session.DisposeAsync().ConfigureAwait(false);
            }, TaskScheduler.Default);
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { _cts?.Cancel(); } catch { /* ignore */ }
        try { _listener?.Stop(); } catch { /* ignore */ }
        var s = Interlocked.Exchange(ref _session, null);
        if (s is not null) await s.DisposeAsync().ConfigureAwait(false);
        if (_acceptLoop is not null)
        {
            try { await _acceptLoop.ConfigureAwait(false); } catch { /* ignore */ }
        }
        _cts?.Dispose();
    }
}

sealed class ClientSession : IAsyncDisposable
{
    readonly TcpClient _client;
    readonly NetworkStream _stream;
    readonly IMarketBridge _bridge;
    readonly int _flushMs;
    readonly ConcurrentDictionary<string, QuoteSnap> _pendingQuotes = new(StringComparer.Ordinal);
    readonly ConcurrentQueue<byte[]> _outFrames = new();
    readonly object _subLock = new();
    Protocol.SubscribeRequest _sub = new(false, "", Array.Empty<string>());
    int _disposed;
    CancellationTokenSource? _runCts;

    public ClientSession(TcpClient client, IMarketBridge bridge, int flushMs)
    {
        _client = client;
        _stream = client.GetStream();
        _bridge = bridge;
        _flushMs = flushMs;
        _bridge.QuotesUpdated += OnQuotes;
        _bridge.IntradayReady += OnIntraday;
        _bridge.MinutesUpdated += OnMinutes;
        _bridge.ReadyChanged += OnReady;
    }

    public async Task RunAsync(CancellationToken outer)
    {
        _runCts = CancellationTokenSource.CreateLinkedTokenSource(outer);
        var ct = _runCts.Token;
        Console.WriteLine("[WryFeedHost] client connected");

        // Hello immediately so Rust UI can show login state
        await Protocol.WriteFrameAsync(_stream, Protocol.EncodeHello(_bridge.IsReady), ct).ConfigureAwait(false);

        var readTask = ReadLoopAsync(ct);
        var flushTask = FlushLoopAsync(ct);
        await Task.WhenAny(readTask, flushTask).ConfigureAwait(false);
        try { _runCts.Cancel(); } catch { /* ignore */ }
        try { await Task.WhenAll(readTask, flushTask).ConfigureAwait(false); } catch { /* ignore */ }
        Console.WriteLine("[WryFeedHost] client disconnected");
    }

    async Task ReadLoopAsync(CancellationToken ct)
    {
        var pending = new List<byte>(4096);
        var tmp = new byte[8192];
        while (!ct.IsCancellationRequested)
        {
            byte[]? payload;
            try
            {
                payload = await Protocol.ReadFrameAsync(_stream, pending, tmp, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { break; }
            catch (InvalidDataException ex)
            {
                Console.Error.WriteLine($"[WryFeedHost] bad frame: {ex.Message}");
                break;
            }
            if (payload is null) break;
            if (!Protocol.TryParseSubscribe(payload, out var req)) continue;
            await ApplySubscribeAsync(req, ct).ConfigureAwait(false);
        }
    }

    async Task ApplySubscribeAsync(Protocol.SubscribeRequest req, CancellationToken ct)
    {
        lock (_subLock) _sub = req;
        // Empty subscribe = drop FieldPool / unsubscribe (engine.rs / UI send this on fake mode)
        if (req.Symbols.Count == 0)
        {
            Console.WriteLine("[WryFeedHost] unsubscribe (0 symbols)");
            await _bridge.UnsubscribeAllAsync(ct).ConfigureAwait(false);
            return;
        }
        Console.WriteLine($"[WryFeedHost] subscribe n={req.Symbols.Count} chart={(req.ChartOn ? req.Chart : "-")}");
        await _bridge.SubscribeAsync(req.Symbols, req.ChartOn ? req.Chart : null, ct).ConfigureAwait(false);
    }

    async Task FlushLoopAsync(CancellationToken ct)
    {
        var batch = new List<QuoteSnap>(64);
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(_flushMs, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }

            // Drain coalesced quotes → one type=2 frame
            batch.Clear();
            foreach (var key in _pendingQuotes.Keys.ToArray())
            {
                if (_pendingQuotes.TryRemove(key, out var q))
                    batch.Add(q);
            }
            if (batch.Count > 0)
            {
                try
                {
                    await Protocol.WriteFrameAsync(_stream, Protocol.EncodeQuotes(batch), ct).ConfigureAwait(false);
                }
                catch { break; }
            }

            // Other frames (intraday / minutes / hello) already queued
            while (_outFrames.TryDequeue(out var frame))
            {
                try { await Protocol.WriteFrameAsync(_stream, frame, ct).ConfigureAwait(false); }
                catch { return; }
            }
        }
    }

    void OnQuotes(IReadOnlyList<QuoteSnap> quotes)
    {
        // Keep latest per symbol — drop stale intermediate ticks
        foreach (var q in quotes)
            _pendingQuotes[q.Symbol] = q;
    }

    void OnIntraday(string symbol, int prevCents, IReadOnlyList<Bar> bars)
        => _outFrames.Enqueue(Protocol.EncodeIntraday(symbol, prevCents, bars));

    void OnMinutes(string symbol, IReadOnlyList<Bar> bars)
        => _outFrames.Enqueue(Protocol.EncodeMinutes(symbol, bars));

    void OnReady(bool ready)
        => _outFrames.Enqueue(Protocol.EncodeHello(ready));

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _bridge.QuotesUpdated -= OnQuotes;
        _bridge.IntradayReady -= OnIntraday;
        _bridge.MinutesUpdated -= OnMinutes;
        _bridge.ReadyChanged -= OnReady;
        try { _runCts?.Cancel(); } catch { /* ignore */ }
        try { _stream.Close(); } catch { /* ignore */ }
        try { _client.Close(); } catch { /* ignore */ }
        _runCts?.Dispose();
        await _bridge.UnsubscribeAllAsync(CancellationToken.None).ConfigureAwait(false);
    }
}
