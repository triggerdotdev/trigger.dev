/**
 * Which store actually served a read-through read: `ReadThroughSource` was an internal return type
 * only, so a cohort ramp was invisible from outside the process. On the hot path, so each label
 * child is resolved once and cached — `inc({ source, shard })` hashes a fresh object per call.
 */
import { Counter, type Registry, type RegistryContentType } from "prom-client";
import { metricsRegister } from "~/metrics.server";
import { singleton } from "~/utils/singleton";
import type { ReadThroughSource } from "./readThrough.server";

const SHARD_PREFIX = "shard:";

export function buildReadThroughSourceMetric(
  register: Registry<RegistryContentType>
): (source: ReadThroughSource) => void {
  const counter = new Counter({
    name: "runops_read_through_source_total",
    help: "Read-through reads served, by the store that served them. `shard` carries the gen-2 shard key.",
    labelNames: ["source", "shard"],
    registers: [register],
  });

  const children = new Map<string, { inc: (value?: number) => void }>();

  return (source) => {
    let child = children.get(source);
    if (child === undefined) {
      // A gen-2 source is split into a constant `source` and the shard key, so one query sums the
      // whole gen-2 cohort and another breaks it down per shard.
      child = source.startsWith(SHARD_PREFIX)
        ? counter.labels("shard", source.slice(SHARD_PREFIX.length))
        : counter.labels(source, "none");
      children.set(source, child);
    }
    child.inc();
  };
}

// singleton: module-scope Counter registration double-registers under dev HMR.
export const recordReadThroughSource = singleton("readThroughSourceMetric", () =>
  buildReadThroughSourceMetric(metricsRegister)
);
