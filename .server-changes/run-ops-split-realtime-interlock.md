---
area: webapp
type: fix
---

Add a boot-time interlock that refuses to enable the run-ops DB split
(`RUN_OPS_SPLIT_ENABLED`) unless the native realtime backend
(`REALTIME_BACKEND_NATIVE_ENABLED`) is also on. Electric replicates only from the
control-plane database, so enabling the split without the native backend would
leave NEW-resident (ksuid) runs invisible to realtime and hang every
subscription. The check runs synchronously on the same eager-boot path as the
existing distinct-DB sentinel and fails fast before any run-ops routing is wired.
