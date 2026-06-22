# inspectctl

MCP server that gives AI agents debugger-level visibility into Node.js processes via the Chrome DevTools Protocol.

Stop pasting `console.log` and heap dumps into your agent. Let it look.

> `main` = stdio transport (default, for Claude Code / Cursor / any local stdio MCP client).
> `http` branch = same toolset + Streamable HTTP transport for cloud / cross-machine clients.

## What it does

| Tool | Action |
|------|--------|
| `heap_snapshot` | V8 heap dump → top N objects + type breakdown (full snapshot on disk) |
| `heap_diff` | Diff two snapshots, find leak culprits |
| `get_stack` | Pause briefly, return sync + async call stack, resume |
| `eval_in_context` | Run an expression in the target (global or call-frame scope) |
| `breakpoint` | Set a breakpoint, block until hit, return locals |
| `profile_cpu` | Sample CPU for N ms, return hot self/total nodes |
| `list_async` | Pending timers, sockets, handles, requests |
| `tail_logs` | Capture console + exceptions for N ms |

Plus `list_targets`, `open_breakpoint_session`, `open_log_session`, `drain_events`, `close_session`, `list_sessions` for discovery and long-lived event streaming.

## Install

```sh
npm install
```

Requires Node 22.6+ for native TypeScript stripping. Tested on Node 24.

## Run

```sh
node src/index.ts        # stdio
npm run target           # spawn demo target on --inspect=9229
```

## MCP client wiring (Claude Code)

```sh
claude mcp add -s user inspectctl -- node your_path/inspectctl/src/index.ts
```

Then in any Claude Code conversation:
- *"Why is the cache growing? heap_snapshot now, wait 10s, snapshot again, diff."*
- *"Set a breakpoint at examples/target.cjs:56, I'll hit /buggy. What's userId?"*
- *"profile_cpu 3000ms while I hit /cpu. Which function is hottest?"*

## Targeting

Every tool accepts:
- `port` — CDP inspector port (default `9229`)
- `host` — default `127.0.0.1`
- `pid` — accepted for API compatibility, used as hint
- `targetId` — specific WS URL when multiple debuggers are listening

## Snapshots and profiles on disk

`heap_snapshot` and `profile_cpu` write their full JSON to `tmpdir()/inspectctl/{snapshots,profiles}/` and return only the summary + path. Open the files in Chrome DevTools (Memory / Performance → Load).

## Caveats

- `get_stack` and `breakpoint` briefly pause the target. Don't aim them at latency-critical hot paths.
- `list_async` uses `process._getActiveHandles()` / `_getActiveRequests()` — unstable Node internals.
- No auth. Don't expose `--inspect` outside localhost.

## License

MIT
