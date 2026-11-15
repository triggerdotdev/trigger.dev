---
"trigger.dev": patch
---

Bundled task files now keep their project layout (for example `/app/src/trigger/tasks.mjs`) when the CLI runs from outside the project, such as `npx trigger.dev deploy`. Before, they could land under a path containing the project's location, away from the files `additionalFiles` copies next to them, so reads relative to `import.meta.url` failed.
