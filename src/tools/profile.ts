/**
 * profile_cpu — run a V8 CPU profile for durationMs, write .cpuprofile
 * to disk, return hot self/total nodes.
 *
 * V8 .cpuprofile structure:
 *   { nodes: [{ id, callFrame, hitCount, children: [id, id, ...] }, ...],
 *     samples: [nodeId, nodeId, ...],
 *     timeDeltas: [..],
 *     startTime, endTime }
 *
 * hitCount is the # of samples whose top frame is this node (self time).
 * totalHits = sum of hitCount across the node + all descendants.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { withClient, type TargetSelector } from "../cdp/client.ts";

const PROFILE_DIR = path.join(os.tmpdir(), "inspectctl", "profiles");

export interface ProfileCpuArgs extends TargetSelector {
  durationMs: number;
  topN?: number;
}

export interface HotNode {
  id: number;
  function: string;
  url: string;
  line: number;
  hitSelf: number;
  hitTotal: number;
  selfPct: number;
  totalPct: number;
}

export interface ProfileCpuResult {
  path: string;
  durationMs: number;
  sampleCount: number;
  totalHits: number;
  hotSelf: HotNode[];
  hotTotal: HotNode[];
}

interface CpuNode {
  id: number;
  callFrame: {
    functionName: string;
    url?: string;
    scriptId?: string;
    lineNumber?: number;
  };
  hitCount?: number;
  children?: number[];
}

function computeTotals(nodes: CpuNode[]): Map<number, number> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const memo = new Map<number, number>();

  function walk(id: number, stack: Set<number>): number {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0; // cycle guard
    stack.add(id);
    const n = byId.get(id);
    if (!n) return 0;
    let total = n.hitCount ?? 0;
    for (const cid of n.children ?? []) {
      total += walk(cid, stack);
    }
    stack.delete(id);
    memo.set(id, total);
    return total;
  }

  for (const n of nodes) walk(n.id, new Set());
  return memo;
}

export async function profileCpu(args: ProfileCpuArgs): Promise<ProfileCpuResult> {
  const { durationMs, topN = 20 } = args;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const fileName = `cpu-${Date.now()}-${process.pid}.cpuprofile`;
  const filePath = path.join(PROFILE_DIR, fileName);

  const profile = await withClient(args, async (client) => {
    const { Profiler } = client;
    await Profiler.enable();
    await Profiler.setSamplingInterval({ interval: 1000 } as any); // 1ms
    await Profiler.start();
    await new Promise((r) => setTimeout(r, durationMs));
    const result = (await Profiler.stop()) as any;
    return result.profile;
  });

  fs.writeFileSync(filePath, JSON.stringify(profile));

  const nodes: CpuNode[] = profile.nodes || [];
  const samples: number[] = profile.samples || [];
  const totalHits = samples.length;
  const totalsById = computeTotals(nodes);

  const summarized = nodes.map((n) => {
    const hitSelf = n.hitCount ?? 0;
    const hitTotal = totalsById.get(n.id) ?? hitSelf;
    return {
      id: n.id,
      function: n.callFrame.functionName || "<anonymous>",
      url: n.callFrame.url || n.callFrame.scriptId || "<unknown>",
      line: (n.callFrame.lineNumber ?? 0) + 1,
      hitSelf,
      hitTotal,
      selfPct: totalHits > 0 ? (hitSelf / totalHits) * 100 : 0,
      totalPct: totalHits > 0 ? (hitTotal / totalHits) * 100 : 0,
    };
  });

  const hotSelf = [...summarized]
    .sort((a, b) => b.hitSelf - a.hitSelf)
    .slice(0, topN);
  const hotTotal = [...summarized]
    .sort((a, b) => b.hitTotal - a.hitTotal)
    .slice(0, topN);

  return {
    path: filePath,
    durationMs,
    sampleCount: totalHits,
    totalHits,
    hotSelf,
    hotTotal,
  };
}
