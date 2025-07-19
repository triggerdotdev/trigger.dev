---
"trigger.dev": patch
---

Added experimental_devProcessCwdInBuildDir config option to opt-in to new process.cwd behavior when executing tasks in the dev CLI. Currently process.cwd maps to the "root" of your trigger.dev project (the directory that contains your trigger.config.ts file). Setting experimental_devProcessCwdInBuildDir to true changes process.cwd to instead be the temporary build directory inside of the .trigger directory.
