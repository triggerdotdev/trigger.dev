// monitorTcpBuffers.ts
import fs from "fs/promises";
import os from "os";
import { logger } from "./logger.server";

/**
 * Parse /proc/net/sockstat and /proc/sys/net/* every `intervalMs`
 * and log the numbers. You can pivot these logs into CloudWatch
 * metrics with a filter pattern if you like.
 */
export function startTcpBufferMonitor(intervalMs = 5_000) {
  async function sampleOnce() {
    try {
      const [sockstat, wmemMax, tcpMem] = await Promise.all([
        fs.readFile("/proc/net/sockstat", "utf8"),
        fs.readFile("/proc/sys/net/core/wmem_max", "utf8"),
        fs.readFile("/proc/sys/net/ipv4/tcp_mem", "utf8"),
      ]);

      logger.debug("tcp-buffer-monitor", {
        sockstat,
        wmemMax,
        tcpMem,
      });

      // /proc/net/sockstat has lines like:
      // TCP: inuse 5 orphan 0 tw 0 alloc 6 mem 409
      const tcpLine = sockstat.split("\n").find((l) => l.startsWith("TCP:")) ?? "";
      const fields = tcpLine.trim().split(/\s+/);
      const inUse = Number(fields[2]); // open sockets
      const alloc = Number(fields[8]); // total sockets with buffers
      const memPages = Number(fields[10]); // pages (4 kB each)
      const memBytes = memPages * 4096;

      const wmemMaxBytes = Number(wmemMax.trim());
      const [low, pressure, high] = tcpMem
        .trim()
        .split(/\s+/)
        .map((n) => Number(n) * 4096); // pages → bytes

      logger.debug("tcp-buffer-monitor", {
        t: Date.now(),
        host: os.hostname(),
        sockets_in_use: inUse,
        sockets_alloc: alloc,
        tcp_mem_bytes: memBytes,
        tcp_mem_high: high,
        wmem_max: wmemMaxBytes,
      });
    } catch (err) {
      // Log and keep going; most errors are “file disappeared for a moment”
      console.error("tcp-buffer-monitor error", err);
    }
  }

  return setInterval(sampleOnce, intervalMs);
}
