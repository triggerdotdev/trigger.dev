export function formatQueryStats(stats: {
  read_rows: string;
  read_bytes: string;
  elapsed_ns: string;
  byte_seconds: string;
}): string {
  const readRows = parseInt(stats.read_rows, 10);
  const readBytes = parseInt(stats.read_bytes, 10);
  const elapsedNs = parseInt(stats.elapsed_ns, 10);
  const byteSeconds = parseFloat(stats.byte_seconds);

  const elapsedMs = elapsedNs / 1_000_000;
  const formattedTime =
    elapsedMs < 1000 ? `${elapsedMs.toFixed(1)}ms` : `${(elapsedMs / 1000).toFixed(2)}s`;
  const formattedBytes = formatBytes(readBytes);

  return `${readRows.toLocaleString()} rows read · ${formattedBytes} · ${formattedTime} · ${formatBytes(
    byteSeconds
  )}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 0) return "-" + formatBytes(-bytes);
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

