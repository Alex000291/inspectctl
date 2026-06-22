import CDP from "chrome-remote-interface";

const DEFAULT_PORT = 9229;
const DEFAULT_HOST = "127.0.0.1";

export interface TargetSelector {
  port?: number;
  host?: string;
  pid?: number; // accepted for API compatibility with proposal, used for hint only
  targetId?: string;
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * List all debug targets exposed by a Node process running with --inspect.
 * Node exposes /json/list on the inspector HTTP endpoint.
 */
export async function listTargets(sel: TargetSelector = {}): Promise<CdpTarget[]> {
  const port = sel.port ?? DEFAULT_PORT;
  const host = sel.host ?? DEFAULT_HOST;
  const targets = await CDP.List({ host, port });
  return targets as unknown as CdpTarget[];
}

/**
 * Open a CDP client to the selected target. Caller MUST close it.
 */
export async function connect(sel: TargetSelector = {}): Promise<CDP.Client> {
  const port = sel.port ?? DEFAULT_PORT;
  const host = sel.host ?? DEFAULT_HOST;

  if (sel.targetId) {
    return CDP({ host, port, target: sel.targetId });
  }

  // Default: pick the first 'node' target.
  const targets = await listTargets({ host, port });
  if (targets.length === 0) {
    throw new Error(
      `No CDP targets at ${host}:${port}. Is the process running with --inspect=${port}?`
    );
  }
  const node = targets.find((t) => t.type === "node") ?? targets[0];
  return CDP({ host, port, target: node.webSocketDebuggerUrl });
}

/**
 * Run an action against a fresh CDP client and clean up afterwards.
 * Use this for one-shot tools (get_stack, eval, heap_snapshot, profile_cpu).
 */
export async function withClient<T>(
  sel: TargetSelector,
  fn: (client: CDP.Client) => Promise<T>
): Promise<T> {
  const client = await connect(sel);
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
}
