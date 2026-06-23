// Reads the apiserver's stored-pod-object count from a Prometheus /metrics scrape.
const POD_COUNT_RE = /^apiserver_storage_objects\{[^}]*resource="pods"[^}]*\}\s+([0-9.eE+-]+)/m;

export function parsePodCount(metricsText: string): number {
  const match = metricsText.match(POD_COUNT_RE);
  if (!match) {
    throw new Error('apiserver_storage_objects{resource="pods"} not found in metrics');
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    throw new Error(`unparseable pod count: ${match[1]}`);
  }
  return value;
}
