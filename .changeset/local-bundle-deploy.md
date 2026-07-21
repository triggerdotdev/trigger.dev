---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Add an experimental `--local-bundle` deploy flag: your project is installed and bundled locally (like classic deploys) and only the build output is uploaded, while the image is still built remotely. Useful when the remote build's install step doesn't work for your project setup.
