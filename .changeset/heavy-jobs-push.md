---
"trigger.dev": patch
---

Fix resolving external packages that are ESM only by falling back to mlly resolvePathSync. This will fix mupdf
