---
area: webapp
type: improvement
---

List API endpoints now clamp the page size to a maximum of 100. Requests asking for a larger page size return up to 100 items and keep paginating, rather than pulling an unbounded page.
