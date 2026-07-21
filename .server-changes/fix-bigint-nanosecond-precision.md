---
area: webapp
type: fix
---

Timestamp precision is no longer lost when recording nanosecond-resolution span times. Previously, multiplying milliseconds by 1,000,000 in float-land before converting to BigInt produced slightly wrong timestamps for spans and run events.
