---
"trigger.dev": patch
---

Detect the esbuild version actually resolved at build time instead of trusting the declared range. A package manager `overrides` entry can install a version the CLI is not tested against without any warning; esbuild 0.25.0 in particular emits sourcemaps whose mappings reference dropped `sources` entries, which makes `source-map-support` throw at runtime inside a deployed task. Known-bad versions now fail the build with a clear message, and other out-of-range versions warn.
