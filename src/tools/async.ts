/**
 * list_async — enumerate pending async work in the target.
 *
 * Uses Node internals via Runtime.evaluate:
 *   - process._getActiveHandles()
 *   - process._getActiveRequests()
 *   - process.getActiveResourcesInfo()  (stable, Node 17.3+)
 *
 * These are NOT a stable API — they're undocumented and may change between
 * Node versions. For tonight's MVP they're plenty.
 */
import { withClient, type TargetSelector } from "../cdp/client.ts";

export interface AsyncSnapshot {
  resourcesInfo: string[];
  handles: Array<{ type: string; detail?: string }>;
  requests: Array<{ type: string; detail?: string }>;
}

const PROBE = `
  (() => {
    const out = { resourcesInfo: [], handles: [], requests: [] };
    const isNode = typeof process !== 'undefined' && typeof process.versions === 'object' && !!process.versions.node;

    if (isNode) {
      try {
        if (typeof process.getActiveResourcesInfo === 'function') {
          out.resourcesInfo = process.getActiveResourcesInfo();
        }
      } catch (e) { out.resourcesInfoError = String(e); }

      const describe = (x) => {
        if (!x) return { type: 'unknown' };
        let type = (x.constructor && x.constructor.name) || typeof x;
        let detail;
        try {
          if (x._idleTimeout !== undefined) detail = 'timeout=' + x._idleTimeout;
          else if (x.address && typeof x.address === 'function') {
            try { const a = x.address(); detail = JSON.stringify(a); } catch (e) {}
          }
        } catch (e) {}
        return detail ? { type, detail } : { type };
      };

      try {
        if (typeof process._getActiveHandles === 'function') {
          out.handles = process._getActiveHandles().map(describe);
        }
      } catch (e) { out.handlesError = String(e); }

      try {
        if (typeof process._getActiveRequests === 'function') {
          out.requests = process._getActiveRequests().map(describe);
        }
      } catch (e) { out.requestsError = String(e); }
    } else {
      // Browser target: use Performance API for resource entries
      try {
        const entries = performance.getEntriesByType('resource');
        out.resourcesInfo = entries.map(e => e.initiatorType + ':' + e.name.slice(0, 120));
      } catch (e) { out.resourcesInfoError = String(e); }
      // No direct browser equivalent for Node handles/requests
      out.handles = [];
      out.requests = [];
    }

    return out;
  })()
`;

export async function listAsync(sel: TargetSelector): Promise<AsyncSnapshot> {
  return withClient(sel, async (client) => {
    const { Runtime } = client;
    await Runtime.enable();
    const r = (await Runtime.evaluate({
      expression: PROBE,
      returnByValue: true,
      awaitPromise: false,
    } as any)) as any;
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ??
          r.exceptionDetails.text ??
          "list_async probe failed"
      );
    }
    return r.result?.value as AsyncSnapshot;
  });
}
