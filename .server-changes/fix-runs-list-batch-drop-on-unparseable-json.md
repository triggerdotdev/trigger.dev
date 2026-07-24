---
area: webapp
type: fix
---

Fixed a rare case where a single run or span carrying data that could not be ingested would make other runs or trace events in the same batch go missing from the runs list, traces, and logs. Now the whole batch is kept: the affected item still appears (a run keeps its status, a span keeps its place in the trace) with only its un-ingestable content dropped, and everything else is stored normally.
