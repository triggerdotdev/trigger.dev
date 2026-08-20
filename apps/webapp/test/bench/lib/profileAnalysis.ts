/**
 * Turns a V8 `.cpuprofile` into ranked CPU attribution.
 *
 * Three views, because they answer different questions:
 *
 *  - by bucket: which package or area of the codebase owns the cycles. This is
 *    the one that says "zod costs more than the database driver".
 *  - by function (self time): the individual frames to go and fix.
 *  - by function (total time): entry points, to sanity-check that the load
 *    actually exercised the route mix that was intended.
 *
 * Frames are symbolicated through the build's source maps first, so a bundled
 * chunk name is reported as the source file it came from.
 */
import { SourceMapResolver } from "./sourcemap";

type CallFrame = {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

type ProfileNode = {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
};

export type CpuProfile = {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
};

type FrameStat = {
  key: string;
  functionName: string;
  location: string;
  selfMs: number;
  selfPercent: number;
  totalMs: number;
  totalPercent: number;
};

type BucketStat = {
  bucket: string;
  selfMs: number;
  selfPercent: number;
};

export type ProfileAnalysis = {
  wallClockMs: number;
  sampledMs: number;
  activeMs: number;
  idleMs: number;
  sampleCount: number;
  buckets: BucketStat[];
  bySelfTime: FrameStat[];
  byTotalTime: FrameStat[];
};

const IDLE_BUCKETS = new Set(["(idle)", "(program)"]);

const FILE_URL_PREFIX = /^file:[/][/]/;
const PNPM_PACKAGE = /node_modules[/]\.pnpm[/]([^/]+)[/]node_modules[/](.+)$/;
const PLAIN_PACKAGE = /node_modules[/](.+)$/;
const WORKSPACE_PACKAGE = /^(?:\.\.[/])*((?:internal-)?packages)[/]([^/]+)[/]/;
const WEBAPP_AREA = /^(?:\.\.[/])*(?:apps[/]webapp[/])?app[/]([^/]+)[/]([^/]+)/;

function packageNameFrom(specifier: string): string {
  const parts = specifier.split("/");
  return parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/**
 * Collapses a source path to the unit a fix would be scoped to: a third-party
 * package, a workspace package, or an area of the webapp.
 */
function bucketForSource(source: string, functionName: string): string {
  if (source === "(gc)" || functionName === "(garbage collector)") return "(gc)";
  if (source === "(program)" || functionName === "(program)") return "(program)";
  if (source === "(idle)" || functionName === "(idle)") return "(idle)";
  if (source.startsWith("node:")) return source;

  const pnpmMatch = source.match(PNPM_PACKAGE);
  if (pnpmMatch) return `npm:${packageNameFrom(pnpmMatch[2]!)}`;

  const plainMatch = source.match(PLAIN_PACKAGE);
  if (plainMatch) return `npm:${packageNameFrom(plainMatch[1]!)}`;

  const workspaceMatch = source.match(WORKSPACE_PACKAGE);
  if (workspaceMatch) return `${workspaceMatch[1]}/${workspaceMatch[2]}`;

  const webappMatch = source.match(WEBAPP_AREA);
  if (webappMatch) {
    const [, top, second] = webappMatch;
    return top === "routes" ? "webapp/routes" : `webapp/app/${top}/${second}`;
  }

  if (source.includes("build/server") || source.includes("build/")) return "webapp/(unmapped)";

  return source.split("/").slice(0, 3).join("/") || "(unknown)";
}

function resolveFrame(
  frame: CallFrame,
  resolver: SourceMapResolver,
  repoRoot: string
): { source: string; location: string } {
  const name = frame.functionName || "(anonymous)";

  if (!frame.url) {
    const synthetic = name.startsWith("(") ? name : "(native)";
    return { source: synthetic, location: synthetic };
  }

  if (frame.url.startsWith("node:")) {
    return { source: frame.url, location: frame.url };
  }

  const filePath = frame.url.replace(FILE_URL_PREFIX, "");
  const mapped = resolver.resolve(filePath, frame.lineNumber, frame.columnNumber);

  if (mapped) {
    return { source: mapped.source, location: `${mapped.source}:${mapped.line}` };
  }

  const relativePath = filePath.startsWith(repoRoot)
    ? filePath.slice(repoRoot.length + 1)
    : filePath;
  return { source: relativePath, location: `${relativePath}:${frame.lineNumber + 1}` };
}

export function analyzeProfile(profile: CpuProfile, repoRoot: string): ProfileAnalysis {
  const resolver = new SourceMapResolver(repoRoot);

  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const childId of node.children ?? []) parentOf.set(childId, node.id);
  }

  const selfMicrosByNode = new Map<number, number>();
  let sampledMicros = 0;

  for (let i = 0; i < profile.samples.length; i++) {
    const nodeId = profile.samples[i]!;
    const delta = profile.timeDeltas[i] ?? 0;
    if (delta <= 0) continue;
    selfMicrosByNode.set(nodeId, (selfMicrosByNode.get(nodeId) ?? 0) + delta);
    sampledMicros += delta;
  }

  const resolvedByNode = new Map<number, { source: string; location: string; name: string }>();
  for (const node of profile.nodes) {
    const { source, location } = resolveFrame(node.callFrame, resolver, repoRoot);
    resolvedByNode.set(node.id, {
      source,
      location,
      name: node.callFrame.functionName || "(anonymous)",
    });
  }

  const bucketMicros = new Map<string, number>();
  const selfMicrosByFrame = new Map<
    string,
    { functionName: string; location: string; micros: number }
  >();

  for (const [nodeId, micros] of selfMicrosByNode) {
    const resolved = resolvedByNode.get(nodeId);
    if (!resolved) continue;

    const bucket = bucketForSource(resolved.source, resolved.name);
    bucketMicros.set(bucket, (bucketMicros.get(bucket) ?? 0) + micros);

    const key = `${resolved.name}@${resolved.location}`;
    const existing = selfMicrosByFrame.get(key);
    if (existing) {
      existing.micros += micros;
    } else {
      selfMicrosByFrame.set(key, {
        micros,
        functionName: resolved.name,
        location: resolved.location,
      });
    }
  }

  const totalMicrosByFrame = new Map<string, number>();
  for (const [nodeId, micros] of selfMicrosByNode) {
    const seen = new Set<string>();
    let current: number | undefined = nodeId;

    while (current !== undefined) {
      const resolved = resolvedByNode.get(current);
      if (resolved) {
        const key = `${resolved.name}@${resolved.location}`;
        if (!seen.has(key)) {
          seen.add(key);
          totalMicrosByFrame.set(key, (totalMicrosByFrame.get(key) ?? 0) + micros);
        }
      }
      current = parentOf.get(current);
    }
  }

  let idleMicros = 0;
  for (const [bucket, micros] of bucketMicros) {
    if (IDLE_BUCKETS.has(bucket)) idleMicros += micros;
  }

  const denominator = sampledMicros - idleMicros || 1;
  const toMs = (micros: number) => micros / 1000;
  const toPercent = (micros: number) => (micros / denominator) * 100;

  const bySelfTime: FrameStat[] = [...selfMicrosByFrame.entries()]
    .filter(([, { functionName }]) => !IDLE_BUCKETS.has(functionName))
    .map(([key, { functionName, location, micros }]) => ({
      key,
      functionName,
      location,
      selfMs: toMs(micros),
      selfPercent: toPercent(micros),
      totalMs: toMs(totalMicrosByFrame.get(key) ?? micros),
      totalPercent: toPercent(totalMicrosByFrame.get(key) ?? micros),
    }))
    .sort((a, b) => b.selfMs - a.selfMs);

  const byTotalTime = [...bySelfTime].sort((a, b) => b.totalMs - a.totalMs);

  const buckets: BucketStat[] = [...bucketMicros.entries()]
    .filter(([bucket]) => !IDLE_BUCKETS.has(bucket))
    .map(([bucket, micros]) => ({
      bucket,
      selfMs: toMs(micros),
      selfPercent: toPercent(micros),
    }))
    .sort((a, b) => b.selfMs - a.selfMs);

  return {
    wallClockMs: (profile.endTime - profile.startTime) / 1000,
    sampledMs: toMs(sampledMicros),
    activeMs: toMs(sampledMicros - idleMicros),
    idleMs: toMs(idleMicros),
    sampleCount: profile.samples.length,
    buckets,
    bySelfTime,
    byTotalTime,
  };
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function formatAnalysis(analysis: ProfileAnalysis, topN = 30): string {
  const sections: string[] = [];

  const busy = analysis.sampledMs > 0 ? (analysis.activeMs / analysis.sampledMs) * 100 : 0;

  sections.push(
    `wall clock ${analysis.wallClockMs.toFixed(0)}ms | on-cpu ${analysis.activeMs.toFixed(0)}ms ` +
      `(${busy.toFixed(1)}% busy, ${analysis.idleMs.toFixed(0)}ms idle) | ${analysis.sampleCount} samples\n` +
      `percentages below are shares of on-cpu time, not of wall clock`
  );

  sections.push(
    "\nCPU by bucket (self time)\n" +
      table(
        ["bucket", "self ms", "self %"],
        analysis.buckets
          .slice(0, topN)
          .map((b) => [b.bucket, b.selfMs.toFixed(1), `${b.selfPercent.toFixed(2)}%`])
      )
  );

  sections.push(
    "\nHottest frames (self time)\n" +
      table(
        ["function", "location", "self ms", "self %", "total %"],
        analysis.bySelfTime
          .slice(0, topN)
          .map((f) => [
            f.functionName,
            f.location,
            f.selfMs.toFixed(1),
            `${f.selfPercent.toFixed(2)}%`,
            `${f.totalPercent.toFixed(2)}%`,
          ])
      )
  );

  sections.push(
    "\nHottest frames (total time, inclusive)\n" +
      table(
        ["function", "location", "total ms", "total %"],
        analysis.byTotalTime
          .slice(0, topN)
          .map((f) => [
            f.functionName,
            f.location,
            f.totalMs.toFixed(1),
            `${f.totalPercent.toFixed(2)}%`,
          ])
      )
  );

  return sections.join("\n");
}
