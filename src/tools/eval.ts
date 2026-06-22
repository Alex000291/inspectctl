/**
 * eval_in_context — evaluate a JS expression in the target.
 *
 * Two modes:
 * - global (default): Runtime.evaluate in the default execution context
 * - frame: pause target, evaluate on a specific callFrame's scope chain
 */
import { withClient, type TargetSelector } from "../cdp/client.ts";

export interface EvalArgs extends TargetSelector {
  expression: string;
  frame?: number;
  returnByValue?: boolean;
  timeoutMs?: number;
}

export interface EvalResult {
  ok: boolean;
  value?: unknown;
  type?: string;
  description?: string;
  exception?: string;
  frame?: number;
}

export async function evalInContext(args: EvalArgs): Promise<EvalResult> {
  const { expression, frame, returnByValue = true, timeoutMs = 5000 } = args;

  return withClient(args, async (client) => {
    const { Runtime, Debugger } = client;
    await Runtime.enable();

    if (frame === undefined) {
      // Global eval.
      const r = (await Runtime.evaluate({
        expression,
        returnByValue,
        awaitPromise: true,
        timeout: timeoutMs,
      } as any)) as any;

      if (r.exceptionDetails) {
        return {
          ok: false,
          exception:
            r.exceptionDetails.exception?.description ??
            r.exceptionDetails.text ??
            "evaluation threw",
        };
      }
      return {
        ok: true,
        value: r.result?.value,
        type: r.result?.type,
        description: r.result?.description,
      };
    }

    // Frame eval: pause target, evaluate on that callFrame.
    await Debugger.enable();

    const result = await new Promise<EvalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        Debugger.resume().catch(() => {});
        resolve({ ok: false, exception: `frame eval timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      const onPaused = async (params: any) => {
        clearTimeout(timer);
        try {
          const frames = params.callFrames || [];
          if (frame >= frames.length) {
            await Debugger.resume();
            resolve({
              ok: false,
              exception: `frame ${frame} out of range (${frames.length} frames)`,
            });
            return;
          }
          const cf = frames[frame];
          const r = (await Debugger.evaluateOnCallFrame({
            callFrameId: cf.callFrameId,
            expression,
            returnByValue,
          } as any)) as any;
          await Debugger.resume();
          if (r.exceptionDetails) {
            resolve({
              ok: false,
              exception:
                r.exceptionDetails.exception?.description ??
                r.exceptionDetails.text ??
                "evaluation threw",
              frame,
            });
          } else {
            resolve({
              ok: true,
              value: r.result?.value,
              type: r.result?.type,
              description: r.result?.description,
              frame,
            });
          }
        } catch (e) {
          reject(e);
        }
      };

      (Debugger as any).once("paused", onPaused);
      Debugger.pause().catch(reject);
    });

    return result;
  });
}
