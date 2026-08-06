---
area: webapp
type: feature
---

The run queue can now serve concurrency keys fairly, so one key with a large backlog no longer starves runs waiting on other keys. It is opt-in and off by default. While a lot of keys on the same queue are all waiting on retry backoffs or future start times, ordering falls back to arrival order until they clear, so runs keep flowing but the fairness guarantee is relaxed for that period.
