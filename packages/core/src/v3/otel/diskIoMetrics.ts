import { type MeterProvider } from "@opentelemetry/sdk-metrics";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";

const SECTOR_SIZE = 512;

const FILTERED_DEVICE_PREFIXES = ["loop", "ram", "dm-"];

type DiskStats = {
  device: string;
  readsCompleted: number;
  sectorsRead: number;
  writesCompleted: number;
  sectorsWritten: number;
};

function parseProcDiskstats(content: string): DiskStats[] {
  const entries: DiskStats[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const fields = trimmed.split(/\s+/);
    if (fields.length < 14) continue;

    const device = fields[2]!;

    if (FILTERED_DEVICE_PREFIXES.some((prefix) => device.startsWith(prefix))) {
      continue;
    }

    entries.push({
      device,
      readsCompleted: parseInt(fields[3]!, 10),
      sectorsRead: parseInt(fields[5]!, 10),
      writesCompleted: parseInt(fields[7]!, 10),
      sectorsWritten: parseInt(fields[9]!, 10),
    });
  }

  return entries;
}

export function startDiskIoMetrics(meterProvider: MeterProvider) {
  try {
    fs.accessSync("/proc/diskstats", fs.constants.R_OK);
  } catch {
    return;
  }

  const meter = meterProvider.getMeter("system-disk", "1.0.0");

  const ioCounter = meter.createObservableCounter("system.disk.io", {
    description: "Disk I/O bytes read and written per device",
    unit: "By",
  });

  const opsCounter = meter.createObservableCounter("system.disk.operations", {
    description: "Disk read/write operation counts per device",
    unit: "{operation}",
  });

  meter.addBatchObservableCallback(
    async (obs) => {
      try {
        const content = await fsPromises.readFile("/proc/diskstats", "utf-8");
        const stats = parseProcDiskstats(content);

        for (const entry of stats) {
          const readAttrs = {
            "system.device": entry.device,
            "disk.io.direction": "read",
          };
          const writeAttrs = {
            "system.device": entry.device,
            "disk.io.direction": "write",
          };

          obs.observe(ioCounter, entry.sectorsRead * SECTOR_SIZE, readAttrs);
          obs.observe(ioCounter, entry.sectorsWritten * SECTOR_SIZE, writeAttrs);

          obs.observe(opsCounter, entry.readsCompleted, readAttrs);
          obs.observe(opsCounter, entry.writesCompleted, writeAttrs);
        }
      } catch {
        // Skip entire cycle on failure
      }
    },
    [ioCounter, opsCounter]
  );
}
