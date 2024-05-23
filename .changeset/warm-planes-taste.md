---
"trigger.dev": patch
---

v3: Prevent legacy-peer-deps=true from breaking deploys

When a global `.npmrc` file includes `legacy-peer-deps=true`, deploys would fail on the `npm ci` step because the package-lock.json wouldn't match the `package.json` file. This is because inside the image build, the `.npmrc` file would not be picked up and so `legacy-peer-deps` would end up being false (which is the default). This change forces the `package-lock.json` file to be created using `legacy-peer-deps=false`
