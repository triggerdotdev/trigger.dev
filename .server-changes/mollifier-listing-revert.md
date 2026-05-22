---
area: webapp
type: improvement
---

Runs list (API and dashboard) is eventually consistent: drop the mollifier-buffer merge so buffered runs no longer appear in `apiClient.listRuns` or the dashboard runs index. Buffered visibility will return via a separate global status indicator.
