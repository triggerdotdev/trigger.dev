---
"trigger.dev": patch
---

Forward `TRIGGER_WORKER_INSTANCE_NAME` into the managed run process env

The Kubernetes workload manager already injects `TRIGGER_WORKER_INSTANCE_NAME`
(= `spec.nodeName`) into the run-controller container via the downward API, but
the managed run worker is forked with an explicit env allowlist
(`RunnerEnv.gatherProcessEnv()`) that dropped it. As a result the run process
could not attach the node as an OpenTelemetry `host.name` resource attribute, so
spans/logs exported to an off-node OTLP collector had no host (Datadog tags these
`issue_type:empty_hostname`). This forwards the value so `trigger.config.ts`
telemetry (or the worker itself) can surface the node/host.
