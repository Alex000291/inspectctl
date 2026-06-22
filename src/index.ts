#!/usr/bin/env node
/**
 * inspectctl — MCP server, stdio transport.
 *
 * Exposes 8 CDP tools to AI agents over MCP stdio:
 *   heap_snapshot, heap_diff, get_stack, eval_in_context,
 *   breakpoint, profile_cpu, list_async, tail_logs
 *
 * Plus discovery + session helpers:
 *   list_targets, open_breakpoint_session, open_log_session,
 *   drain_events, close_session, list_sessions
 *
 * For the Streamable HTTP transport variant, switch to the `http` branch.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

// Common target selector shape — used by every CDP tool.
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

const server = new McpServer({
  name: "inspectctl",
  version: "0.0.1",
});

// --- discovery --------------------------------------------------------------

server.tool(
  "list_targets",
  "List all CDP debug targets on a given host:port.",
  targetSchema,
  async (args) => {
    try {
      return json(await listTargets(args));
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
    frame: z.number().int().optional().describe("0-based call-frame index (pauses target)"),
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
  { sessionId: z.string() },
  async ({ sessionId }) => {
    const session = getSession(sessionId);
    if (!session) return err(new Error(`unknown session ${sessionId}`));
    return json({ events: drainEvents(session) });
  }
);

server.tool(
  "close_session",
  "Close a long-lived session and release its CDP connection.",
  { sessionId: z.string() },
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

// --- run --------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("inspectctl MCP server running on stdio (14 tools)\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e}\n`);
  process.exit(1);
});
