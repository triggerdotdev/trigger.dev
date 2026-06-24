---
area: webapp
type: improvement
---

Dashboard line charts (Run metrics, AI metrics, custom dashboards, and the Models pages — anything rendered by `QueryResultsChart`) now choose how many x-axis time labels to show based on the chart's rendered width, instead of a fixed cap of ~8. Wide charts show more labels; narrow widgets show fewer. The continuous time scale is unchanged, so gaps in the data still render as gaps.
