---
area: webapp
type: fix
---

Fix IEEE 754 precision loss in OTLP nanosecond timestamps by converting epoch ms to BigInt before multiplication
