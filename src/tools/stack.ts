/**
 * get_stack — pause briefly, capture the full sync + async call stack,
 * then resume the target.
 *
 * Pauses are very short (we don't run any user code), but they DO stop
 * the world. Don't aim at latency-critical hot paths.
 */
import { withClient, type TargetSelector } from "../cdp/client.ts";

export interface StackFrame {
  function: string;
  url: string;
  line: number;
  column: number;
  scriptId?: string;
}

export interface AsyncStackTrace {
  description: string;
  callFrames: StackFrame[];
  parent?: AsyncStackTrace;
}

export interface GetStackResult {
  callFrames: StackFrame[];
  asyncStackTrace?: AsyncStackTrace;
}

function mapFrames(frames: any[]): StackFrame[] {
  return frames.map((f) => ({
    function: f.functionName || "<anonymous>",
    url: f.url || f.scriptId || "<unknown>",
    line: (f.lineNumber ?? 0) + 1,
    column: (f.columnNumber ?? 0) + 1,
    scriptId: f.scriptId,
  }));
}

function mapAsync(trace: any | undefined): AsyncStackTrace | undefined {
  if (!trace) return undefined;
  return {
    description: trace.description || "async",
    callFrames: mapFrames(trace.callFrames ?? []),
    parent: mapAsync(trace.parent),
  };
}

export async function getStack(sel: TargetSelector): Promise<GetStackResult> {
  return withClient(sel, async (client) => {
    const { Debugger, Runtime } = client;
    await Debugger.enable();
    await Debugger.setAsyncCallStackDepth({ maxDepth: 32 });

    // Capture a stack via Runtime.evaluate(..., { generatePreview: true })
    // which returns the current async stack as well — works even without
    // an active pause and avoids touching scheduler in deep code paths.
    const stack = await Runtime.evaluate({
      expression: "void 0",
      includeCommandLineAPI: false,
      // generatePreview not relevant; key is that the protocol returns
      // exceptionDetails / stackTrace on every evaluate.
    } as any);

    // Trigger a real pause briefly to also capture currently-running frames
    // (Runtime.evaluate above runs in a fresh microtask, so we miss the
    // user's actual stack). Pause + immediately resume.
    let frames: any[] = [];
    let asyncTrace: any = undefined;
    await new Promise<void>((resolve, reject) => {
      const onPaused = (params: any) => {
        frames = params.callFrames || [];
        asyncTrace = params.asyncStackTrace;
        Debugger.resume()
          .then(() => resolve())
          .catch(reject);
      };
      client.once("Debugger.paused", onPaused);
      Debugger.pause().catch(reject);
      // Safety timeout.
      setTimeout(() => {
        try {
          client.removeListener("Debugger.paused", onPaused);
        } catch {}
        resolve();
      }, 1500);
    });

    void stack;
    return {
      callFrames: mapFrames(frames),
      asyncStackTrace: mapAsync(asyncTrace),
    };
  });
}
