/**
 * heap_snapshot — capture a V8 heap snapshot via HeapProfiler.takeHeapSnapshot.
 * heap_diff   — compare two snapshots, surface biggest growth by type.
 *
 * V8 .heapsnapshot is a JSON file with:
 *   { snapshot: { meta: { node_fields, edge_fields, ... }, node_count, edge_count, ... },
 *     nodes: [flat array of node_count * node_fields.length integers],
 *     edges: [flat array of edge_count * edge_fields.length integers],
 *     strings: [...] }
 *
 * We parse only the nodes array — for tonight's MVP, edge graph traversal
 * isn't necessary. byType breakdown + top-by-selfSize is enough to point
 * the agent at the leak.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { withClient, type TargetSelector } from "../cdp/client.ts";

const SNAPSHOT_DIR = path.join(os.tmpdir(), "inspectctl", "snapshots");

export interface HeapSnapshotArgs extends TargetSelector {
  topN?: number;
}

export interface ObjectSummary {
  id: number;
  type: string;
  name: string;
  selfSize: number;
}

export interface HeapSnapshotResult {
  path: string;
  totalNodes: number;
  totalSelfSize: number;
  byType: Array<{ type: string; count: number; selfSize: number }>;
  topObjects: ObjectSummary[];
}

interface ParsedHeap {
  nodes: ObjectSummary[];
  byType: Map<string, { count: number; selfSize: number }>;
  totalSelfSize: number;
}

function parseHeapSnapshot(filePath: string): ParsedHeap {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const meta = raw.snapshot.meta;
  const nodeFields: string[] = meta.node_fields;
  const nodeTypes: string[] = meta.node_types[0]; // first column is "type" enum
  const strings: string[] = raw.strings;
  const stride = nodeFields.length;

  const typeIdx = nodeFields.indexOf("type");
  const nameIdx = nodeFields.indexOf("name");
  const idIdx = nodeFields.indexOf("id");
  const selfSizeIdx = nodeFields.indexOf("self_size");

  const nodes: ObjectSummary[] = [];
  const byType = new Map<string, { count: number; selfSize: number }>();
  let total = 0;

  for (let i = 0; i < raw.nodes.length; i += stride) {
    const typeIndex = raw.nodes[i + typeIdx];
    const nameStrIdx = raw.nodes[i + nameIdx];
    const id = raw.nodes[i + idIdx];
    const selfSize = raw.nodes[i + selfSizeIdx];

    const type = nodeTypes[typeIndex] ?? "?";
    const name = strings[nameStrIdx] ?? "";

    nodes.push({ id, type, name, selfSize });
    total += selfSize;

    const tkey = name ? `${type}:${name}` : type;
    const cur = byType.get(tkey) ?? { count: 0, selfSize: 0 };
    cur.count++;
    cur.selfSize += selfSize;
    byType.set(tkey, cur);
  }

  return { nodes, byType, totalSelfSize: total };
}

export async function heapSnapshot(
  args: HeapSnapshotArgs
): Promise<HeapSnapshotResult> {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const fileName = `snap-${Date.now()}-${process.pid}.heapsnapshot`;
  const filePath = path.join(SNAPSHOT_DIR, fileName);

  await withClient(args, async (client) => {
    const { HeapProfiler } = client;
    await HeapProfiler.enable();

    // The protocol streams the snapshot in chunks as HeapProfiler.addHeapSnapshotChunk events.
    const chunks: string[] = [];
    const onChunk = (params: any) => {
      chunks.push(params.chunk);
    };
    (HeapProfiler as any).on("addHeapSnapshotChunk", onChunk);

    try {
      await HeapProfiler.takeHeapSnapshot({ reportProgress: false } as any);
    } finally {
      try {
        (client as any).removeListener?.(
          "HeapProfiler.addHeapSnapshotChunk",
          onChunk
        );
      } catch {}
    }

    fs.writeFileSync(filePath, chunks.join(""));
  });

  const parsed = parseHeapSnapshot(filePath);
  const topN = args.topN ?? 20;
  const topObjects = [...parsed.nodes]
    .sort((a, b) => b.selfSize - a.selfSize)
    .slice(0, topN);
  const byTypeArr = [...parsed.byType.entries()]
    .map(([type, v]) => ({ type, count: v.count, selfSize: v.selfSize }))
    .sort((a, b) => b.selfSize - a.selfSize)
    .slice(0, topN);

  return {
    path: filePath,
    totalNodes: parsed.nodes.length,
    totalSelfSize: parsed.totalSelfSize,
    byType: byTypeArr,
    topObjects,
  };
}

export interface HeapDiffArgs {
  before: string;
  after: string;
  topN?: number;
}

export interface HeapDiffResult {
  before: string;
  after: string;
  deltaNodes: number;
  deltaSelfSize: number;
  growthByType: Array<{
    type: string;
    countBefore: number;
    countAfter: number;
    deltaCount: number;
    sizeBefore: number;
    sizeAfter: number;
    deltaSize: number;
  }>;
}

export async function heapDiff(args: HeapDiffArgs): Promise<HeapDiffResult> {
  const a = parseHeapSnapshot(args.before);
  const b = parseHeapSnapshot(args.after);
  const topN = args.topN ?? 20;

  const keys = new Set<string>([...a.byType.keys(), ...b.byType.keys()]);
  const growth = [...keys].map((type) => {
    const bA = a.byType.get(type) ?? { count: 0, selfSize: 0 };
    const bB = b.byType.get(type) ?? { count: 0, selfSize: 0 };
    return {
      type,
      countBefore: bA.count,
      countAfter: bB.count,
      deltaCount: bB.count - bA.count,
      sizeBefore: bA.selfSize,
      sizeAfter: bB.selfSize,
      deltaSize: bB.selfSize - bA.selfSize,
    };
  });
  growth.sort((x, y) => y.deltaSize - x.deltaSize);

  return {
    before: args.before,
    after: args.after,
    deltaNodes: b.nodes.length - a.nodes.length,
    deltaSelfSize: b.totalSelfSize - a.totalSelfSize,
    growthByType: growth.slice(0, topN),
  };
}
