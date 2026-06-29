---
area: webapp
type: feature
---

Agent sessions started from the Test playground are now flagged with a real `Session.isTest` boolean instead of a `"playground"` tag, surfaced as a dedicated "Test" column (check icon) in the Sessions table on both the Sessions and Agent pages, plus a matching property on the session detail page. The legacy `"playground"` tag is hidden from the Tags display on pre-existing sessions.
