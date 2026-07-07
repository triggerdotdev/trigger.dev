---
area: webapp
type: fix
---

Anchor batch item run-ops residency on the batch's own friendlyId (not a fresh per-org flag read) in the run-engine batch trigger service and the BatchQueue item callback, on both the success path and the pre-failed-run failure path, so a mid-batch mint-flag flip can no longer mint an item (or a pre-failed item) into a different physical store than its BatchTaskRun row.
