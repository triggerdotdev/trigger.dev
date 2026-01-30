---
"@trigger.dev/webapp": patch
---

Fix batchTriggerAndWait running forever when duplicate idempotencyKey is provided in the same batch

When using batchTriggerAndWait with duplicate idempotencyKeys in the same batch, the batch would never complete because the completedCount and expectedCount would be mismatched. This fix ensures that cached runs (duplicate idempotencyKeys) are properly tracked in the batch, with their completedCount incremented immediately if the cached run is already in a final status.
