---
"@trigger.dev/build": patch
---

fix(build): add destination option to additionalFiles extension

When using glob patterns with parent directory references (../), the default behavior strips ".." segments resulting in unexpected paths. This adds an optional "destination" parameter that allows users to explicitly specify where matched files should be placed, which is useful in monorepo setups where files need to maintain their structure.
