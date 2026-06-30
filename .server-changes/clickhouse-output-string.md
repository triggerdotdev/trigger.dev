---
area: webapp
type: fix
---

Store task run output as serialized JSON text in ClickHouse instead of the native JSON column. Deeply nested output could exceed ClickHouse 26.2's `input_format_binary_max_type_complexity` limit, causing some runs to fail replication and appear stuck.
