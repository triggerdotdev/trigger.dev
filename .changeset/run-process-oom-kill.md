---
"trigger.dev": patch
---

Report a run whose process the kernel killed for running out of memory as `TASK_PROCESS_OOM_KILLED`, rather than as a generic exit after `SIGKILL`, when the out-of-memory kill is counted in the run's cgroup.
