---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Deploys on the `bun-1.4` runtime now compile the run worker and your task files into a Bun executable with bytecode, so runs start faster. `import.meta.url` and `__dirname` still point at your files under `/app`, so files you read next to your code must be in the image as before (e.g. with `additionalFiles`). Set `build.bunBytecode: false` in `trigger.config.ts` to turn compilation off.
