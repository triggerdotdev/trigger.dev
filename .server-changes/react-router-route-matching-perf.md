---
area: webapp
type: improvement
---

Speed up the dashboard and API under high request load by memoizing react-router's per-request route matching, which previously re-flattened, re-ranked, and recompiled the entire route table on every request.
