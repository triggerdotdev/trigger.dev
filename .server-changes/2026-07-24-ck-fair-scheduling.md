---
area: webapp
type: feature
---

The run queue can now serve concurrency keys fairly, so one key with a large backlog no longer starves runs waiting on other keys. It is opt-in and off by default.
