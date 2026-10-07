# WryFeedHost

TCP companion for [wry-xq-demo](../). Publishes market data on `127.0.0.1:47631` using the binary protocol in `src/engine.rs` (LE u32 length-prefixed frames).

## Build

```bash
cd feedhost
dotnet build -c Release
```

Runs on `net8.0` (Linux CI can build the protocol server). For live DAQEngine wiring on Windows, keep the host beside a logged-in XQNext; optional package `XQData.DAQEngine.Client` 0.43.0.

## Run (Windows, real XQNext)

1. Start **XQNext** and log in (SysJust token / production login). WPF UI must be able to start the engine; FieldPool / RT need a successful login.
2. Start WryFeedHost (no `--demo-ticks`):

   ```bat
   cd feedhost\WryFeedHost
   dotnet run -c Release
   ```

3. Run wry-xq-demo and choose **Engine** in the title bar.

Empty subscribe (0 symbols) = unsubscribe / drop FieldPool view.

### Engine bridge status

`EngineBridge` currently stubs RT / FieldPool hooks (`RT_RefQuote2=429`, `KData_Min=2001`, …). Live quotes need:

- Spawn / attach `DAQEngine\XQNextEngine.exe` via named pipe `\\.\Pipe\DAQEngine\{AppId}{PipeName}\Port`
- Framed TCP to the port from that pipe (FrameStart `0x02`, ends `0x03`/`0x04`)
- Login + `RTClient` Init/SetAuth/SetExch/Connect, then `RT_RefQuote2` / `RT_AddTick2`

**Wine**: engine process may stay up but named pipes do **not** appear — do not rely on Wine for live feed. Use real Windows beside XQNext.

## Path-test mode (not live data)

```bash
dotnet run -c Release -- --demo-ticks
```

Pushes synthetic high-rate binary quotes/minutes for protocol / UI path testing. **Not** SysJust / XQNext live market data — console banner labels this clearly.

Optional: `--flush-ms 16` (default 25) to coalesce quote frames.
