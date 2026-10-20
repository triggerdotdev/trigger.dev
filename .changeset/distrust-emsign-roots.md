---
"trigger.dev": patch
---

Deploy images no longer trust the emSign roots removed after the October 2026 eMudhra CA key compromise, or the Sectigo AAA root that cross-signs the compromised intermediates. Node and Bun tasks now refuse TLS connections through the compromised eMudhra intermediates, including their Sectigo AAA cross-signed copies.
