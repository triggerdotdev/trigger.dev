---
area: webapp
type: fix
---

Dashboard pages no longer keep polling for updates while their browser tab is hidden, which could leave a tab you came back to showing a connection error instead of your data. Pages refresh when you return to the tab.
