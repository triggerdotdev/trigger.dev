import { RunsReplicationService } from "./runsReplicationService.server";

const GLOBAL_RUNS_REPLICATION_KEY = Symbol.for("dev.trigger.ts.runs-replication");
const GLOBAL_TCP_MONITOR_KEY = Symbol.for("dev.trigger.ts.tcp-monitor");

type RunsReplicationGlobal = {
  [GLOBAL_RUNS_REPLICATION_KEY]?: RunsReplicationService;
  [GLOBAL_TCP_MONITOR_KEY]?: NodeJS.Timeout;
};

const _globalThis = typeof globalThis === "object" ? globalThis : global;
const _global = _globalThis as RunsReplicationGlobal;

export function getRunsReplicationGlobal(): RunsReplicationService | undefined {
  return _global[GLOBAL_RUNS_REPLICATION_KEY];
}

export function setRunsReplicationGlobal(service: RunsReplicationService) {
  _global[GLOBAL_RUNS_REPLICATION_KEY] = service;
}

export function unregisterRunsReplicationGlobal() {
  delete _global[GLOBAL_RUNS_REPLICATION_KEY];
}

export function getTcpMonitorGlobal(): NodeJS.Timeout | undefined {
  return _global[GLOBAL_TCP_MONITOR_KEY];
}

export function setTcpMonitorGlobal(timeout: NodeJS.Timeout) {
  _global[GLOBAL_TCP_MONITOR_KEY] = timeout;
}

export function unregisterTcpMonitorGlobal() {
  delete _global[GLOBAL_TCP_MONITOR_KEY];
}
