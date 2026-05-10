---
area: webapp
type: fix
---

Fix the run-view inspector panel glitching out and locking up in Firefox. Disabled the underlying resizable library's collapse animation on Firefox (where its `requestAnimationFrame`-driven actor caused visual glitches and intermittent state-machine errors) while keeping it intact for Chromium and Safari, and bumped the inspector minimum from 50px to 250px so dragging can't shrink the panel into a near-useless width.
