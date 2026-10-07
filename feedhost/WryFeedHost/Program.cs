using WryFeedHost;

static class Program
{
    static async Task<int> Main(string[] args)
    {
        var demo = args.Any(a => a is "--demo-ticks" or "--demo");
        var flushMs = 25;
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] is "--flush-ms" && int.TryParse(args[i + 1], out var ms))
                flushMs = ms;
        }

        Console.WriteLine("WryFeedHost — wry-xq-demo companion (TCP 127.0.0.1:47631)");
        if (demo)
        {
            Console.WriteLine("Mode: --demo-ticks  *** path-test ONLY — NOT live SysJust / XQNext data ***");
        }
        else
        {
            Console.WriteLine("Mode: engine bridge (stub until SysJust login + RT_RefQuote2 wired on Windows)");
            Console.WriteLine("  Run beside a logged-in XQNext on Windows. Wine named pipes do not work.");
            Console.WriteLine("  For protocol path testing without creds: pass --demo-ticks");
        }

        IMarketBridge bridge = demo ? new DemoTicksBridge() : new EngineBridge();
        await using var server = new TcpServer(bridge, flushMs);
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        await server.StartAsync(cts.Token).ConfigureAwait(false);
        try
        {
            await Task.Delay(Timeout.Infinite, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // shut down
        }

        await bridge.DisposeAsync().ConfigureAwait(false);
        Console.WriteLine("WryFeedHost stopped.");
        return 0;
    }
}
