---
paths:
  - "**/package.json"
---

# Installing Packages

When adding a new dependency to any package.json in the monorepo:

1. **Look up the latest version** on npm before adding:
   ```bash
   pnpm view <package-name> version
   ```
   If unsure which version to use (e.g. major version compatibility), confirm with the user.

2. **Edit the package.json directly** — do NOT use `pnpm add` as it can cause issues in the monorepo. Add the dependency with the correct version range (typically `^x.y.z`).

3. **Run `pnpm i` from the repo root** after editing to install and update the lockfile:
   ```bash
   pnpm i
   ```
   Always run from the repo root, not from the package directory.
