import { type MeterProvider } from "@opentelemetry/sdk-metrics";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";

const VIRTUAL_FS_TYPES = new Set([
  "proc",
  "sysfs",
  "devpts",
  "tmpfs",
  "devtmpfs",
  "cgroup",
  "cgroup2",
  "squashfs",
  "autofs",
  "debugfs",
  "securityfs",
  "pstore",
  "bpf",
  "tracefs",
  "hugetlbfs",
  "mqueue",
  "fusectl",
  "configfs",
  "binfmt_misc",
]);

type MountEntry = {
  device: string;
  mountpoint: string;
  fsType: string;
  options: string;
};

function parseProcMounts(content: string): MountEntry[] {
  const entries: MountEntry[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    const parts = line.split(" ");
    if (parts.length < 4) continue;

    const fsType = parts[2]!;
    if (VIRTUAL_FS_TYPES.has(fsType)) continue;

    entries.push({
      device: parts[0]!,
      mountpoint: unescapeMountPath(parts[1]!),
      fsType,
      options: parts[3]!,
    });
  }

  return entries;
}

function unescapeMountPath(path: string): string {
  return path.replace(/\\040/g, " ").replace(/\\011/g, "\t");
}

export function startFilesystemMetrics(meterProvider: MeterProvider) {
  try {
    fs.accessSync("/proc/mounts", fs.constants.R_OK);
  } catch {
    return;
  }

  if (typeof fsPromises.statfs !== "function") {
    return;
  }

  const meter = meterProvider.getMeter("system-filesystem", "1.0.0");

  const usageCounter = meter.createObservableUpDownCounter("system.filesystem.usage", {
    description: "Filesystem bytes used, free, and reserved per mountpoint",
    unit: "By",
  });

  const utilizationGauge = meter.createObservableGauge("system.filesystem.utilization", {
    description: "Fraction of filesystem space used (0-1)",
    unit: "1",
  });

  meter.addBatchObservableCallback(
    async (obs) => {
      try {
        const mountsContent = await fsPromises.readFile("/proc/mounts", "utf-8");
        const mounts = parseProcMounts(mountsContent);

        for (const mount of mounts) {
          try {
            const stats = await fsPromises.statfs(mount.mountpoint);
            const bsize = stats.bsize;
            const total = stats.blocks * bsize;
            const free = stats.bavail * bsize;
            const reserved = (stats.bfree - stats.bavail) * bsize;
            const used = total - stats.bfree * bsize;

            const mode = mount.options.startsWith("ro") ? "ro" : "rw";

            const baseAttrs = {
              "system.device": mount.device,
              "system.filesystem.type": mount.fsType,
              "system.filesystem.mountpoint": mount.mountpoint,
              "system.filesystem.mode": mode,
            };

            obs.observe(usageCounter, used, {
              ...baseAttrs,
              "system.filesystem.state": "used",
            });
            obs.observe(usageCounter, free, {
              ...baseAttrs,
              "system.filesystem.state": "free",
            });
            obs.observe(usageCounter, reserved, {
              ...baseAttrs,
              "system.filesystem.state": "reserved",
            });

            if (total > 0) {
              obs.observe(utilizationGauge, used / total, baseAttrs);
            }
          } catch {
            // Skip this mount on statfs failure
          }
        }
      } catch {
        // Skip entire cycle on failure
      }
    },
    [usageCounter, utilizationGauge]
  );
}
