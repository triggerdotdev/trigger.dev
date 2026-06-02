// Rewrites the version of every public packages/* package to a unique,
// preview-only semver (0.0.0-preview-<sha>) BEFORE the build runs.
//
// Why this exists:
//   pkg.pr.new serves preview builds by commit SHA but does NOT change the
//   package.json "version" field (as of 0.0.75). If a preview is published
//   while package.json still says e.g. 4.5.0-rc.4, a consumer who installs the
//   preview pins 4.5.0-rc.4 to the pkg.pr.new tarball in their lockfile/cache,
//   and a later `npm i @trigger.dev/sdk@4.5.0-rc.4` from npm can resolve to the
//   stale preview. See stackblitz-labs/pkg.pr.new#250 and #390.
//
//   A 0.0.0- prefix can never satisfy a real semver range, so the collision
//   becomes structurally impossible (the same convention React/Next canaries
//   use).
//
//   Running BEFORE the build also means scripts/updateVersion.ts bakes this
//   same preview version into the runtime VERSION constant, so previews are
//   self-identifying (trigger --version, the x-trigger-cli-version header, the
//   MCP server version, etc.) rather than all reporting the RC version.
//
//   Sibling workspace: specifiers are relaxed to workspace:* so `pnpm pack`
//   resolves them against the rewritten versions without range-validation
//   errors. packages/python pins peerDependencies as workspace:^4.5.0-rc.4,
//   which would otherwise be unsatisfiable once the sibling version changes.
//
// Note: pkg.pr.new PR #525 adds a built-in --previewVersion flag. Once that
// ships we could drop the version-rewrite half here, but we still want a
// pre-build stamp so updateVersion.ts picks up the preview version (the flag
// rewrites at pack time, which is too late for the baked VERSION constant).

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const PACKAGES_DIR = "packages";
const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function resolveSha() {
  const sha = process.argv[2] || process.env.GITHUB_SHA;
  if (sha) return sha;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "Could not determine commit SHA (pass as the first argument or set GITHUB_SHA)"
    );
  }
}

const sha = resolveSha().slice(0, 7);
const previewVersion = `0.0.0-preview-${sha}`;

const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true }).filter((e) =>
  e.isDirectory()
);

// First pass: collect every public package name so we know which workspace
// specifiers point at a sibling whose version we are about to change.
const publicNames = new Set();
const manifests = [];
for (const dir of dirs) {
  const pkgPath = join(PACKAGES_DIR, dir.name, "package.json");
  if (!existsSync(pkgPath)) continue;
  const json = JSON.parse(readFileSync(pkgPath, "utf8"));
  manifests.push({ pkgPath, json });
  if (!json.private && json.name) publicNames.add(json.name);
}

// Second pass: stamp the version and relax sibling workspace specifiers.
let stamped = 0;
for (const { pkgPath, json } of manifests) {
  if (json.private) continue;
  json.version = previewVersion;
  for (const section of DEP_SECTIONS) {
    const deps = json[section];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (publicNames.has(name) && String(spec).startsWith("workspace:")) {
        deps[name] = "workspace:*";
      }
    }
  }
  writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
  stamped++;
}

console.log(`Stamped ${stamped} public package(s) to ${previewVersion}`);
