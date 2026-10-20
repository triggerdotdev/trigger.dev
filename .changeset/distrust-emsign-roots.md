---
"trigger.dev": patch
---

Deploy images no longer trust the emSign roots removed after the October 2026 eMudhra CA key compromise, or the Sectigo AAA root that cross-signs the compromised intermediates. Node tasks now validate TLS against the pruned system store. Bun tasks keep Bun's bundled roots until Bun ships a fix.
