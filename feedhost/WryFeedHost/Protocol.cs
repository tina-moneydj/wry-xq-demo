using System.Buffers.Binary;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

namespace WryFeedHost;

/// <summary>
/// Binary wire protocol matching wry-xq-demo <c>src/engine.rs</c>.
/// Frame = LE u32 length + payload. Text = u8 len + utf8 (max 96).
/// </summary>
static class Protocol
{
    public const ushort Port = 47631;
    public const int MaxSymbols = 64;
    public const int MaxText = 96;

    public const byte MsgSubscribe = 1; // client → host
    public const byte MsgHello = 1;     // host → client
    public const byte MsgQuotes = 2;
    public const byte MsgIntraday = 3;
    public const byte MsgMinutes = 4;

    public readonly record struct SubscribeRequest(bool ChartOn, string Chart, IReadOnlyList<string> Symbols);

    public static void WriteText(List<byte> body, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text ?? "");
        var n = Math.Min(bytes.Length, MaxText);
        body.Add((byte)n);
        body.AddRange(bytes.AsSpan(0, n).ToArray());
    }

    public static string ReadText(ReadOnlySpan<byte> buf, ref int i)
    {
        if (i >= buf.Length) return "";
        int n = buf[i++];
        if (n < 0 || i + n > buf.Length) { i = buf.Length; return ""; }
        var s = Encoding.UTF8.GetString(buf.Slice(i, n));
        i += n;
        return s;
    }

    public static bool TryParseSubscribe(ReadOnlySpan<byte> payload, out SubscribeRequest req)
    {
        req = default;
        if (payload.Length < 1 || payload[0] != MsgSubscribe) return false;
        int i = 1;
        if (i >= payload.Length) return false;
        bool chartOn = payload[i++] != 0;
        string chart = ReadText(payload, ref i);
        if (i + 2 > payload.Length) return false;
        int count = BinaryPrimitives.ReadUInt16LittleEndian(payload.Slice(i));
        i += 2;
        count = Math.Min(count, MaxSymbols);
        var symbols = new List<string>(count);
        for (int s = 0; s < count; s++)
            symbols.Add(ReadText(payload, ref i));
        req = new SubscribeRequest(chartOn, chart, symbols);
        return true;
    }

    public static byte[] EncodeHello(bool ready)
    {
        var body = new List<byte>(2) { MsgHello, (byte)(ready ? 1 : 0) };
        return Frame(body);
    }

    public static byte[] EncodeQuotes(IReadOnlyList<QuoteSnap> quotes)
    {
        var body = new List<byte>(64 + quotes.Count * 48) { MsgQuotes };
        Span<byte> u16 = stackalloc byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(u16, (ushort)Math.Min(quotes.Count, ushort.MaxValue));
        body.Add(u16[0]); body.Add(u16[1]);
        var n = Math.Min(quotes.Count, ushort.MaxValue);
        for (int i = 0; i < n; i++)
        {
            var q = quotes[i];
            WriteText(body, q.Symbol);
            WriteText(body, q.Name);
            WriteI32(body, q.PriceCents);
            WriteI32(body, q.ChangeCents);
            WriteI64(body, q.Volume);
        }
        return Frame(body);
    }

    public static byte[] EncodeIntraday(string symbol, int prevCents, IReadOnlyList<Bar> bars)
    {
        var body = new List<byte>(32 + bars.Count * 30) { MsgIntraday };
        WriteText(body, symbol);
        WriteI32(body, prevCents);
        Span<byte> u16 = stackalloc byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(u16, (ushort)Math.Min(bars.Count, ushort.MaxValue));
        body.Add(u16[0]); body.Add(u16[1]);
        var n = Math.Min(bars.Count, ushort.MaxValue);
        for (int i = 0; i < n; i++) WriteBar(body, bars[i]);
        return Frame(body);
    }

    public static byte[] EncodeMinutes(string symbol, IReadOnlyList<Bar> bars)
    {
        var body = new List<byte>(16 + bars.Count * 30) { MsgMinutes };
        WriteText(body, symbol);
        Span<byte> u16 = stackalloc byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(u16, (ushort)Math.Min(bars.Count, ushort.MaxValue));
        body.Add(u16[0]); body.Add(u16[1]);
        var n = Math.Min(bars.Count, ushort.MaxValue);
        for (int i = 0; i < n; i++) WriteBar(body, bars[i]);
        return Frame(body);
    }

    static void WriteBar(List<byte> body, Bar b)
    {
        Span<byte> u16 = stackalloc byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(u16, b.T);
        body.Add(u16[0]); body.Add(u16[1]);
        WriteI32(body, b.O); WriteI32(body, b.H); WriteI32(body, b.L); WriteI32(body, b.C);
        WriteI64(body, b.V);
    }

    static void WriteI32(List<byte> body, int v)
    {
        Span<byte> b = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(b, v);
        body.Add(b[0]); body.Add(b[1]); body.Add(b[2]); body.Add(b[3]);
    }

    static void WriteI64(List<byte> body, long v)
    {
        Span<byte> b = stackalloc byte[8];
        BinaryPrimitives.WriteInt64LittleEndian(b, v);
        for (int i = 0; i < 8; i++) body.Add(b[i]);
    }

    public static byte[] Frame(List<byte> body)
    {
        var frame = new byte[4 + body.Count];
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(0, 4), (uint)body.Count);
        body.CopyTo(frame, 4);
        return frame;
    }

    public static async Task WriteFrameAsync(NetworkStream stream, byte[] frame, CancellationToken ct)
    {
        await stream.WriteAsync(frame, ct).ConfigureAwait(false);
    }

    /// <summary>Read one length-prefixed frame into <paramref name="pending"/> then return payload.</summary>
    public static async Task<byte[]?> ReadFrameAsync(NetworkStream stream, List<byte> pending, byte[] tmp, CancellationToken ct)
    {
        while (true)
        {
            if (TryTakeFrame(pending, out var payload))
                return payload;
            int n;
            try
            {
                n = await stream.ReadAsync(tmp, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { throw; }
            catch (IOException) { return null; }
            if (n == 0) return null;
            pending.AddRange(tmp.AsSpan(0, n).ToArray());
        }
    }

    public static bool TryTakeFrame(List<byte> pending, out byte[] payload)
    {
        payload = Array.Empty<byte>();
        if (pending.Count < 4) return false;
        int len = (int)BinaryPrimitives.ReadUInt32LittleEndian(CollectionsMarshal.AsSpan(pending)[..4]);
        if (len <= 0 || len > 8_000_000) throw new InvalidDataException("bad frame length");
        if (pending.Count < 4 + len) return false;
        payload = pending.GetRange(4, len).ToArray();
        pending.RemoveRange(0, 4 + len);
        return true;
    }
}

readonly record struct QuoteSnap(string Symbol, string Name, int PriceCents, int ChangeCents, long Volume);

readonly record struct Bar(ushort T, int O, int H, int L, int C, long V);
