#!/usr/bin/env node
/**
 * inspectctl MCP server entry point.
 *
 * Exposes 8 tools over MCP stdio transport:
 *   heap_snapshot, heap_diff, get_stack, eval_in_context,
 *   breakpoint, profile_cpu, list_async, tail_logs
 *
 * Plus session helpers:
 *   open_breakpoint_session, open_log_session, drain_events, close_session
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";

import { listTargets } from "./cdp/client.ts";
import { drainEvents, getSession, closeSession, listSessions } from "./cdp/session.ts";
import { getStack } from "./tools/stack.ts";
import { evalInContext } from "./tools/eval.ts";
import { heapSnapshot, heapDiff } from "./tools/heap.ts";
import { breakpoint, openBreakpointSession } from "./tools/breakpoint.ts";
import { profileCpu } from "./tools/profile.ts";
import { listAsync } from "./tools/async.ts";
import { tailLogs, openLogSession } from "./tools/logs.ts";

// Common target selector shape — used by every tool.
const targetSchema = {
  port: z.number().int().optional().describe("CDP inspector port (default 9229)"),
  host: z.string().optional().describe("CDP host (default 127.0.0.1)"),
  pid: z.number().int().optional().describe("Process ID hint (informational)"),
  targetId: z.string().optional().describe("Specific CDP target WS URL"),
};

function json(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `ERROR: ${msg}` }],
  };
}

// Build a fresh McpServer instance with all tools registered. For stdio
// we build it once at startup. For HTTP we build a new one per request
// (stateless pattern recommended by the MCP TS SDK examples).
function buildServer(): McpServer {
  const server = new McpServer({
    name: "inspectctl",
    version: "0.0.1",
  });

  registerTools(server);
  return server;
}

function registerTools(server: McpServer) {
  // --- discovery --------------------------------------------------------------

  server.tool(
  "list_targets",
  "List all CDP debug targets on a given host:port.",
  targetSchema,
  async (args) => {
    try {
      const targets = await listTargets(args);
      return json(targets);
    } catch (e) {
      return err(e);
    }
  }
);

// --- get_stack --------------------------------------------------------------

server.tool(
  "get_stack",
  "Pause the target briefly, return the full call stack with async parents, then resume.",
  targetSchema,
  async (args) => {
    try {
      return json(await getStack(args));
    } catch (e) {
      return err(e);
    }
  }
);

// --- eval_in_context --------------------------------------------------------

server.tool(
  "eval_in_context",
  "Evaluate a JS expression in the target. With frame, pauses and runs on that call frame; otherwise runs globally.",
  {
    ...targetSchema,
    expression: z.string().describe("JS expression to evaluate"),
    frame: z
      .number()
      .int()
      .optional()
      .describe("0-based call-frame index (pauses target)"),
    returnByValue: z.boolean().optional(),
    timeoutMs: z.number().int().optional(),
  },
  async (args) => {
    try {
      return json(await evalInContext(args));
    } catch (e) {
      return err(e);
    }
  }
);

// --- heap_snapshot ----------------------------------------------------------

server.tool(
  "heap_snapshot",
  "Take a V8 heap snapshot. Writes the full .heapsnapshot to disk; returns top N objects + type breakdown.",
  {
    ...targetSchema,
    topN: z.number().int().optional().describe("Top objects to return (default 20)"),
  },
  async (args) => {
    try {
      return json(await heapSnapshot(args));
    } catch (e) {
      return err(e);
    }
  }
);

// --- heap_diff --------------------------------------------------------------

server.tool(
  "heap_diff",
  "Diff two heap snapshots (paths returned from heap_snapshot). Returns top growth by type.",
  {
    before: z.string().describe("Path to earlier .heapsnapshot"),
    after: z.string().describe("Path to later .heapsnapshot"),
    topN: z.number().int().optional(),
  },
  async (args) => {
    try {
      return json(await heapDiff(args));
    } catch (e) {
      return err(e);
    }
  }
);

// --- breakpoint -------------------------------------------------------------

server.tool(
  "breakpoint",
  "Set a breakpoint and block until first hit (or timeout). Returns call frames + top-frame locals.",
  {
    ...targetSchema,
    file: z.string().describe("File path or URL fragment to match"),
    line: z.number().int().describe("Line number (1-based)"),
    column: z.number().int().optional(),
    condition: z.string().optional().describe("JS expression; only breaks if truthy"),
    timeoutMs: z.number().int().optional().describe("Default 30000"),
  },
  async (args) => {
    try {
      return json(await breakpoint(args));
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "open_breakpoint_session",
  "Set a long-lived breakpoint. Returns sessionId; poll drain_events to read hits.",
  {
    ...targetSchema,
    file: z.string(),
    line: z.number().int(),
    column: z.number().int().optional(),
    condition: z.string().optional(),
  },
  async (args) => {
    try {
      return json(await openBreakpointSession(args));
    } catch (e) {
      return err(e);
    }
  }
);

// --- profile_cpu ------------------------------------------------------------

server.tool(
  "profile_cpu",
  "Run a CPU profile for durationMs. Writes .cpuprofile to disk; returns hot self/total nodes.",
  {
    ...targetSchema,
    durationMs: z.number().int().describe("Sample duration in ms"),
    topN: z.number().int().optional(),
  },
  async (args) => {
    try {
      return json(await profileCpu(args));
    } catch (e) {
      return err(e);
    }
  }
);

// --- list_async -------------------------------------------------------------

server.tool(
  "list_async",
  "List pending async work in the target: timers, sockets, requests, handles.",
  targetSchema,
  async (args) => {
    try {
      return json(await listAsync(args));
    } catch (e) {
      return err(e);
    }
  }
);

// --- tail_logs --------------------------------------------------------------

server.tool(
  "tail_logs",
  "Capture console output + exceptions for durationMs.",
  {
    ...targetSchema,
    durationMs: z.number().int(),
    maxEntries: z.number().int().optional(),
  },
  async (args) => {
    try {
      return json(await tailLogs(args));
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "open_log_session",
  "Open a long-lived log capture session. Returns sessionId; poll drain_events to read.",
  targetSchema,
  async (args) => {
    try {
      return json(await openLogSession(args));
    } catch (e) {
      return err(e);
    }
  }
);

// --- session management -----------------------------------------------------

server.tool(
  "drain_events",
  "Drain buffered events from a session (breakpoint or log).",
  {
    sessionId: z.string(),
  },
  async ({ sessionId }) => {
    const session = getSession(sessionId);
    if (!session) return err(new Error(`unknown session ${sessionId}`));
    return json({ events: drainEvents(session) });
  }
);

server.tool(
  "close_session",
  "Close a long-lived session and release its CDP connection.",
  {
    sessionId: z.string(),
  },
  async ({ sessionId }) => {
    const ok = await closeSession(sessionId);
    return json({ closed: ok });
  }
);

  server.tool(
    "list_sessions",
    "List currently open sessions.",
    {},
    async () => json({ sessions: listSessions() })
  );
}

// --- run --------------------------------------------------------------------

async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe — stdout is reserved for MCP protocol frames.
  process.stderr.write("inspectctl MCP server running on stdio\n");
}

async function runHttp(port: number, host: string) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Stateless mode per MCP TS SDK best practice: each request gets a
  // fresh McpServer + transport with sessionIdGenerator: undefined.
  // Long-running CDP state lives in cdp/session.ts at module scope so
  // it survives across MCP requests anyway.
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      process.stderr.write(`POST /mcp error: ${e}\n`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        });
      }
    }
  });

  // For stateless mode, GET and DELETE are unused.
  app.get("/mcp", (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "method not allowed (stateless mode)" },
        id: null,
      })
    );
  });
  app.delete("/mcp", (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "method not allowed (stateless mode)" },
        id: null,
      })
    );
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, transport: "streamable-http", mode: "stateless" });
  });

  // Clients (Claude Code, etc.) may probe OAuth metadata + dynamic client
  // registration endpoints. We don't use OAuth — return JSON 404s so they
  // don't try to parse our default HTML 404 and crash.
  const noAuth = (_req: express.Request, res: express.Response) => {
    res.status(404).json({
      error: "not_supported",
      error_description: "inspectctl does not implement OAuth",
    });
  };
  app.get("/.well-known/oauth-authorization-server", noAuth);
  app.get("/.well-known/oauth-protected-resource", noAuth);
  app.get("/.well-known/openid-configuration", noAuth);
  app.post("/register", noAuth);
  app.post("/token", noAuth);
  app.get("/authorize", noAuth);

  // Final catch-all → JSON 404 (no Express HTML).
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Error middleware MUST come after routes. Catches body-parser errors
  // and any route-level throws, returning a JSON-RPC error envelope.
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) return next(err);
      process.stderr.write(`HTTP error: ${err.message || err}\n`);
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32700, message: `parse error: ${err.message || err}` },
        id: null,
      });
    }
  );

  app.listen(port, host, () => {
    process.stderr.write(
      `inspectctl MCP server on http://${host}:${port}/mcp\n`
    );
  });
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let mode: "stdio" | "http" = "stdio";
  let port = 7878;
  let host = "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--http") {
      mode = "http";
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        port = parseInt(next, 10);
        i++;
      }
    } else if (a === "--port") {
      port = parseInt(args[++i] ?? "", 10);
    } else if (a === "--host") {
      host = args[++i] ?? host;
    } else if (a === "--stdio") {
      mode = "stdio";
    } else if (a === "--help" || a === "-h") {
      process.stderr.write(
        [
          "inspectctl — MCP debugger for Node.js processes",
          "",
          "Usage:",
          "  inspectctl                       run on stdio (default; for Claude Code, Cursor)",
          "  inspectctl --http [port]         run as Streamable HTTP MCP (default port 7878)",
          "  inspectctl --http --port 8080    explicit port",
          "  inspectctl --http --host 0.0.0.0 bind on all interfaces (dangerous)",
          "",
        ].join("\n")
      );
      process.exit(0);
    }
  }
  return { mode, port, host };
}

async function main() {
  const { mode, port, host } = parseArgs(process.argv);
  if (mode === "http") {
    await runHttp(port, host);
  } else {
    await runStdio();
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e}\n`);
  process.exit(1);
});
