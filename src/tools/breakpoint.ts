/**
 * breakpoint — one-shot: set a BP, wait for first hit (or timeout),
 *              return call frames + top-frame locals, resume.
 *
 * open_breakpoint_session — long-lived: set a BP, return sessionId.
 *                           Each hit is buffered and drained via drain_events.
 */
import { withClient, type TargetSelector } from "../cdp/client.ts";
import { openSession, pushEvent, type Session } from "../cdp/session.ts";

export interface BreakpointArgs extends TargetSelector {
  file: string;
  line: number;
  column?: number;
  condition?: string;
  timeoutMs?: number;
}

export interface BreakpointHit {
  hitAt: number;
  reason: string;
  callFrames: Array<{
    function: string;
    url: string;
    line: number;
    column: number;
  }>;
  topFrameLocals: Record<string, unknown>;
}

async function setBPAndArm(client: any, args: BreakpointArgs) {
  const { Debugger } = client;
  await Debugger.enable();
  const r = await Debugger.setBreakpointByUrl({
    urlRegex: escapeForUrlRegex(args.file),
    lineNumber: Math.max(0, args.line - 1),
    columnNumber: args.column !== undefined ? Math.max(0, args.column - 1) : 0,
    condition: args.condition,
  } as any);
  return r;
}

function escapeForUrlRegex(fragment: string): string {
  // Convert Windows paths and file fragments into a CDP-friendly URL regex.
  // CDP matches against the full script URL, so we use a substring regex.
  return fragment.replace(/[\\.+*?^$|()[\]{}]/g, (m) =>
    m === "\\" ? "[\\\\/]" : `\\${m}`
  );
}

async function extractTopLocals(client: any, callFrame: any) {
  const { Runtime } = client;
  const out: Record<string, unknown> = {};
  for (const scope of callFrame.scopeChain || []) {
    if (scope.type === "global") continue; // too noisy
    try {
      const props = (await Runtime.getProperties({
        objectId: scope.object.objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: false,
      } as any)) as any;
      for (const p of props.result || []) {
        if (p.value === undefined) continue;
        const key = `${scope.type}:${p.name}`;
        out[key] = p.value.value ?? p.value.description ?? `<${p.value.type}>`;
      }
    } catch {
      // ignore scope read failures
    }
  }
  return out;
}

export async function breakpoint(args: BreakpointArgs): Promise<BreakpointHit> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  return withClient(args, async (client) => {
    const { Debugger } = client;
    await setBPAndArm(client, args);

    return new Promise<BreakpointHit>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          (client as any).removeListener?.("Debugger.paused", onPaused);
        } catch {}
        reject(new Error(`breakpoint never hit within ${timeoutMs}ms`));
      }, timeoutMs);

      const onPaused = async (params: any) => {
        clearTimeout(timer);
        try {
          (client as any).removeListener?.("Debugger.paused", onPaused);
        } catch {}
        try {
          const frames = (params.callFrames || []).map((f: any) => ({
            function: f.functionName || "<anonymous>",
            url: f.url || "<unknown>",
            line: (f.location?.lineNumber ?? 0) + 1,
            column: (f.location?.columnNumber ?? 0) + 1,
          }));
          const locals =
            params.callFrames && params.callFrames[0]
              ? await extractTopLocals(client, params.callFrames[0])
              : {};
          await Debugger.resume();
          resolve({
            hitAt: Date.now(),
            reason: params.reason || "other",
            callFrames: frames,
            topFrameLocals: locals,
          });
        } catch (e) {
          reject(e);
        }
      };

      (Debugger as any).on("paused", onPaused);
    });
  });
}

export interface OpenBreakpointSessionArgs extends TargetSelector {
  file: string;
  line: number;
  column?: number;
  condition?: string;
}

export async function openBreakpointSession(args: OpenBreakpointSessionArgs) {
  const session = await openSession("breakpoint", args, {
    file: args.file,
    line: args.line,
  });
  const { client } = session;

  await setBPAndArm(client as any, args as BreakpointArgs);

  // Stream every hit into the session buffer.
  (client.Debugger as any).on("paused", async (params: any) => {
    try {
      const frames = (params.callFrames || []).map((f: any) => ({
        function: f.functionName || "<anonymous>",
        url: f.url || "<unknown>",
        line: (f.location?.lineNumber ?? 0) + 1,
        column: (f.location?.columnNumber ?? 0) + 1,
      }));
      const locals =
        params.callFrames && params.callFrames[0]
          ? await extractTopLocals(client, params.callFrames[0])
          : {};
      pushEvent(session as Session, "paused", {
        reason: params.reason,
        callFrames: frames,
        topFrameLocals: locals,
      });
    } finally {
      try {
        await client.Debugger.resume();
      } catch {}
    }
  });

  return { sessionId: session.id };
}
