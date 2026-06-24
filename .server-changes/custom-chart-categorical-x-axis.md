---
area: webapp
type: improvement
---

Custom chart (Query mode) and dashboard charts now keep their x-axis readable for non-date values like run IDs and task names, with no configuration:

- Labels are thinned to only as many as fit the chart's width (evenly spaced); all data still renders, full value shows on hover.
- Long values are middle-truncated (`run_abc…f9c2`) so IDs that share a prefix stay distinguishable.
- The axis auto-rotates to -45° only when labels are long; short labels stay horizontal.

Also made bar and line charts share the same margins so they stay aligned when toggling chart type, and so angled labels are no longer clipped on line charts.
