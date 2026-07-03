---
area: webapp
type: improvement
---

The three charts on the Models page "Your models" tab (Cost / Tokens / Calls over
time) now share the interactive behaviour from the agent landing page charts:
hovering one draws a synced vertical line at the same bucket on the other two, and
dragging across a chart zooms the Time/Date filter. The maximize button + "v"
shortcut and the width-aware x-axis / abbreviated y-axis were already inherited
from the shared query-widget primitives.

Achieved by wrapping the three `MetricWidget`s in a `ChartSyncProvider` with
`useZoomToTimeFilter` — no new chart code, the sync/zoom support already lives in
`Chart.Bar`. Also made two small DRY passes on the primitives shared with the
agent charts: the duplicated "v" maximize-on-hover shortcut in `ChartCard` and
`QueryWidget` was extracted into a `useMaximizeShortcut` hook, and
`ChartBar`'s drag From/To tooltip now looks up the real data point so it renders
on the query-widget path (which keys tooltips off `__rawDate`) as well as the
activity-chart path (which keys off `bucket`).
