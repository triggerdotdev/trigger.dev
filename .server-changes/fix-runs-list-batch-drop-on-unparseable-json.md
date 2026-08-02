---
area: webapp
type: fix
---

Fixed a rare case where a single run or span carrying data that could not be ingested would make other runs or trace events in the same batch go missing from the runs list, traces, and logs. Now the rest of the batch is always kept: an affected run still appears with its status (only its un-ingestable output is dropped), and an affected trace event or payload is skipped instead of taking down everything around it.
