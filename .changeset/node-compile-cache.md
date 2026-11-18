---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Deploys on the `node-24` and `node-26` runtimes now build a Node compile cache for your bundled code during the image build, so runs spend less time compiling your tasks and their dependencies before they start. `node-22` deploys are unchanged.
