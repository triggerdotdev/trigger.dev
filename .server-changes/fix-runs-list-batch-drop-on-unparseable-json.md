---
area: webapp
type: fix
---

Fixed a rare case where a single run or span carrying data that could not be ingested would make other runs or trace events in the same batch go missing from the runs list, traces, and logs. Now only the affected item is dropped and everything else is stored normally.
