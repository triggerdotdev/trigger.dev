import type { Job } from "../shared/types";

export type WorkflowPhase = "prepare" | "edit" | "finish" | "ready";

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function progressFromRun(job: Job, run: unknown): number {
  if (!run || typeof run !== "object") return Math.min(job.progress, job.results.length ? 100 : 95);
  const snapshot = run as { id?: unknown; metadata?: unknown };
  if (snapshot.id !== job.runId) return Math.min(job.progress, job.results.length ? 100 : 95);
  const metadata = snapshot.metadata;
  const record =
    metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  const phaseProgress = finiteNumber(record.progress) ?? 0;
  const readyFlags = [record.heroReady, record.cardReady, record.squareReady];
  const hasReadyFlags = readyFlags.some((flag) => typeof flag === "boolean");
  const completedExports = hasReadyFlags
    ? readyFlags.filter((flag) => flag === true).length
    : finiteNumber(record.completedExports);
  const exportProgress =
    record.phase === "finish" && completedExports !== undefined
      ? 65 + Math.max(0, Math.min(3, completedExports)) * 10
      : 0;
  const progress = Math.max(job.progress, phaseProgress, exportProgress);
  return Math.max(0, Math.min(job.results.length ? 100 : 95, progress));
}

export function workflowPhase(progress: number, hasResults: boolean): WorkflowPhase {
  if (hasResults) return "ready";
  if (progress < 25) return "prepare";
  if (progress < 65) return "edit";
  return "finish";
}
