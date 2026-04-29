---
area: webapp
type: fix
---

Prevent dashboard crash (React error #31) when span accessory item text is not a string. Filters out malformed accessory items in SpanCodePathAccessory instead of passing objects to React as children.
