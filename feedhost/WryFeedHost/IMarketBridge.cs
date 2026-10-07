namespace WryFeedHost;

/// <summary>Market-data source behind the TCP protocol server.</summary>
interface IMarketBridge : IAsyncDisposable
{
    string Name { get; }
    bool IsReady { get; }

    event Action<IReadOnlyList<QuoteSnap>>? QuotesUpdated;
    event Action<string, int, IReadOnlyList<Bar>>? IntradayReady;
    event Action<string, IReadOnlyList<Bar>>? MinutesUpdated;
    event Action<bool>? ReadyChanged;

    Task SubscribeAsync(IReadOnlyList<string> symbols, string? chartSymbol, CancellationToken ct);
    Task UnsubscribeAllAsync(CancellationToken ct);
}
