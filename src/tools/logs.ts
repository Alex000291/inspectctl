/**
 * tail_logs — capture Runtime.consoleAPICalled + Runtime.exceptionThrown
 * for durationMs, return buffered entries.
 *
 * open_log_session — same capture but long-lived; drain via drain_events.
 */
import { withClient, type TargetSelector } from "../cdp/client.ts";
import { openSession, pushEvent, type Session } from "../cdp/session.ts";

export interface TailLogsArgs extends TargetSelector {
  durationMs: number;
  maxEntries?: number;
}

export interface LogEntry {
  ts: number;
  kind: "console" | "exception";
  level?: string;
  text: string;
  url?: string;
  line?: number;
  stack?: Array<{ function: string; url: string; line: number }>;
}

function describeArg(a: any): string {
  if (a == null) return String(a);
  if (a.value !== undefined) return String(a.value);
  if (a.description) return a.description;
  return `<${a.type}>`;
}

function consoleToEntry(params: any): LogEntry {
  const args = (params.args || []).map(describeArg).join(" ");
  const frames = (params.stackTrace?.callFrames || []).map((f: any) => ({
    function: f.functionName || "<anonymous>",
    url: f.url || "<unknown>",
    line: (f.lineNumber ?? 0) + 1,
  }));
  return {
    ts: Date.now(),
    kind: "console",
    level: params.type,
    text: args,
    url: frames[0]?.url,
    line: frames[0]?.line,
    stack: frames,
  };
}

function exceptionToEntry(params: any): LogEntry {
  const d = params.exceptionDetails || {};
  const frames = (d.stackTrace?.callFrames || []).map((f: any) => ({
    function: f.functionName || "<anonymous>",
    url: f.url || "<unknown>",
    line: (f.lineNumber ?? 0) + 1,
  }));
  return {
    ts: Date.now(),
    kind: "exception",
    text:
      d.exception?.description ??
      d.text ??
      "uncaught exception",
    url: frames[0]?.url ?? d.url,
    line: frames[0]?.line ?? (d.lineNumber ?? 0) + 1,
    stack: frames,
  };
}

export async function tailLogs(args: TailLogsArgs): Promise<{ entries: LogEntry[] }> {
  const { durationMs, maxEntries = 1000 } = args;
  return withClient(args, async (client) => {
    const { Runtime } = client;
    await Runtime.enable();

    const entries: LogEntry[] = [];

    const onConsole = (p: any) => {
      if (entries.length < maxEntries) entries.push(consoleToEntry(p));
    };
    const onException = (p: any) => {
      if (entries.length < maxEntries) entries.push(exceptionToEntry(p));
    };

    (Runtime as any).on("consoleAPICalled", onConsole);
    (Runtime as any).on("exceptionThrown", onException);

    try {
      await new Promise((r) => setTimeout(r, durationMs));
    } finally {
      try {
        (client as any).removeListener?.("Runtime.consoleAPICalled", onConsole);
        (client as any).removeListener?.("Runtime.exceptionThrown", onException);
      } catch {}
    }

    return { entries };
  });
}

export async function openLogSession(args: TargetSelector) {
  const session = await openSession("logs", args, {});
  const { client } = session;
  const { Runtime } = client;
  await Runtime.enable();

  (Runtime as any).on("consoleAPICalled", (p: any) => {
    pushEvent(session as Session, "console", consoleToEntry(p));
  });
  (Runtime as any).on("exceptionThrown", (p: any) => {
    pushEvent(session as Session, "exception", exceptionToEntry(p));
  });

  return { sessionId: session.id };
}
