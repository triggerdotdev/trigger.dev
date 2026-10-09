---
area: webapp
type: fix
---

Fix OTLP trace timestamps losing precision for runs after approximately 2255 AD. Timestamps are now computed with full 64-bit integer arithmetic.
