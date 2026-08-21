---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Add an experimental `--local-bundle` deploy flag that runs the install and bundling steps on your machine and uploads only the build output; the image is still built remotely. Useful when your project's install step needs tooling or credentials that only exist locally.
