import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type OomKillCounterPaths = {
  procSelfCgroup: string;
  cgroupRoot: string;
};

/** This process's own cgroup (cgroup v2), which a forked child shares. */
export const OWN_CGROUP_OOM_KILL_COUNTER: OomKillCounterPaths = {
  procSelfCgroup: "/proc/self/cgroup",
  cgroupRoot: "/sys/fs/cgroup",
};

/**
 * How many processes the kernel's out-of-memory killer has killed in the cgroup `paths` name, or
 * undefined when the read takes longer than `timeoutMs` or there is no such counter: cgroup v1, a
 * non-Linux host, or a file that cannot be read.
 */
export async function readOomKillCountWithin(
  paths: OomKillCounterPaths,
  timeoutMs: number
): Promise<number | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, undefined);
  });
  try {
    return await Promise.race([readOomKillCount(paths), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readOomKillCount(paths: OomKillCounterPaths): Promise<number | undefined> {
  try {
    const cgroup = cgroupV2Path(await readFile(paths.procSelfCgroup, "utf8"));
    if (cgroup === undefined) {
      return undefined;
    }
    const events = await readFile(join(paths.cgroupRoot, cgroup, "memory.events"), "utf8");
    return parseOomKills(events);
  } catch {
    return undefined;
  }
}

/** The unified hierarchy's entry in /proc/self/cgroup is the one with id 0 and no controllers. */
function cgroupV2Path(procSelfCgroup: string): string | undefined {
  for (const line of procSelfCgroup.split("\n")) {
    if (line.startsWith("0::")) {
      return line.slice(3);
    }
  }
  return undefined;
}

/** `oom_kill` counts kills; `oom` counts invocations, which can end without one. */
function parseOomKills(memoryEvents: string): number | undefined {
  for (const line of memoryEvents.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === "oom_kill") {
      const count = Number(value);
      return Number.isInteger(count) ? count : undefined;
    }
  }
  return undefined;
}
