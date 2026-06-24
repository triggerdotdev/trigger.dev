---
area: webapp
type: improvement
---

Improve the activity charts on the agent, standard, and scheduled task landing pages:

- Bucket density now adapts to the selected time range, so short ranges (e.g. "5 min") render many fine-grained bars instead of a single 1-hour bar.
- X-axis labels are chosen dynamically based on the available width — evenly spaced, first + last always shown, kept horizontal, and reflowed on resize so they no longer overlap.
- Charts on the agent page share a synced vertical hover indicator (reusable via `ChartSyncProvider`).
- Click-drag across a chart to zoom into that time range — the selection mirrors across synced charts and sets the Time/Date filter to the dragged window.
- Each chart card gains a "Maximize" button (fullscreen dialog + `v` shortcut), matching the dashboard widgets.
- Y-axis values are abbreviated (8000 → "8K") by default across the compound charts.

Also de-duplicates the previously copy-pasted status colors, time-axis formatters, and bucket/zero-fill logic into shared helpers.
