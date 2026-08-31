---
"trigger.dev": patch
---

Forward `TRIGGER_WORKER_INSTANCE_NAME` into the task run process so run telemetry reports the host it executed on. On Kubernetes the supervisor already sources the node name from the downward API, but it never reached the forked run process, so OTLP spans exported to an off-node collector arrived with an empty hostname.
