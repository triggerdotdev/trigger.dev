import * as fs from "node:fs/promises";
import * as path from "node:path";

// Snapshots the user-facing docs into the SDK package, so AI coding agents can read the
// version-pinned reference directly from node_modules (zero drift). Run as part of
// `@trigger.dev/sdk`'s build, from the package dir.
//
// The manifest is the entire "Documentation" dropdown in `docs/docs.json` (the
// "Resources for Trigger.dev" tab) — every page under it is bundled. Add a page to that
// nav and it ships automatically; nothing else to edit. The API reference and
// Guides & examples dropdowns are intentionally not bundled. Skills reference into this
// set by path; their `sources:` frontmatter is informational and no longer drives bundling.
//
// Layout: nav page `tasks/overview` is copied from `docs/tasks/overview.mdx` to
// `<sdk>/docs/tasks/overview.mdx`, so a skill at `<sdk>/skills/<name>/SKILL.md` reaches it
// at `../../docs/tasks/overview.mdx` and an agent reaches it at `@trigger.dev/sdk/docs/...`.

const packageDir = process.cwd(); // packages/trigger-sdk when run from the SDK build
const repoRoot = path.resolve(packageDir, "..", "..");
const docsRoot = path.join(repoRoot, "docs");
const outDir = path.join(packageDir, "docs");

const DROPDOWN = "Documentation";

/** Recursively collect every page path under a docs.json nav node (groups -> pages, nested). */
function collectPages(node: unknown): string[] {
  const out: string[] = [];
  if (node && typeof node === "object") {
    const n = node as { groups?: unknown[]; pages?: unknown[] };
    for (const g of n.groups ?? []) out.push(...collectPages(g));
    for (const p of n.pages ?? []) {
      if (typeof p === "string") out.push(p);
      else out.push(...collectPages(p));
    }
  }
  return out;
}

async function collectManifest(): Promise<string[]> {
  const docsJson = JSON.parse(await fs.readFile(path.join(docsRoot, "docs.json"), "utf8"));
  const dropdowns: Array<{ dropdown?: string }> = docsJson?.navigation?.dropdowns ?? [];
  const documentation = dropdowns.find((d) => d.dropdown === DROPDOWN);

  if (!documentation) {
    throw new Error(`[bundleSdkDocs] "${DROPDOWN}" dropdown not found in docs/docs.json`);
  }

  // Page paths are root-relative without extension (e.g. "tasks/overview"); map to docs/*.mdx.
  return [...new Set(collectPages(documentation))];
}

async function bundleSdkDocs() {
  // When the SDK is built as a dependency inside a pruned workspace (e.g. the webapp Docker
  // image), the repo-level docs/ tree is a separate workspace package that isn't part of that
  // build's dependency graph, so it isn't present. The SDK isn't being published there, so
  // there's nothing to bundle: skip rather than fail. Publishing always runs from the full
  // monorepo where docs/ exists, so the guards below still protect releases.
  try {
    await fs.access(docsRoot);
  } catch {
    console.log(`[bundleSdkDocs] docs/ not present at ${docsRoot}; skipping (pruned build)`);
    return;
  }

  const manifest = await collectManifest();

  if (manifest.length === 0) {
    // The nav structure changed shape; refuse to ship the SDK with no docs.
    throw new Error(`[bundleSdkDocs] no pages found under the "${DROPDOWN}" dropdown`);
  }

  // Rebuild from scratch so removed pages don't linger in the package.
  await fs.rm(outDir, { recursive: true, force: true });

  const missing: string[] = [];
  let copied = 0;

  for (const rel of manifest) {
    // Defensive: nav paths come from our own docs.json and are URL-style, but a
    // fat-fingered `../`, a backslash, or an absolute path shouldn't be able to copy a
    // file from outside docs/ into the package. Reject backslashes (Windows separator)
    // and both POSIX and Windows absolute forms, then the normalized `..` traversal.
    const safeRel = path.posix.normalize(rel);
    if (
      rel.includes("\\") ||
      path.posix.isAbsolute(rel) ||
      path.win32.isAbsolute(rel) ||
      safeRel.startsWith("..")
    ) {
      throw new Error(`[bundleSdkDocs] invalid nav path "${rel}" under "${DROPDOWN}"`);
    }

    const src = path.join(docsRoot, `${safeRel}.mdx`);
    try {
      await fs.access(src);
    } catch {
      // A nav entry pointing at a nonexistent page is a docs-nav issue, not a bundler one.
      // Warn and skip rather than fail the SDK build.
      missing.push(rel);
      continue;
    }
    const dest = path.join(outDir, `${safeRel}.mdx`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    copied++;
  }

  if (missing.length > 0) {
    console.warn(
      `[bundleSdkDocs] ${missing.length} "${DROPDOWN}" nav page(s) have no .mdx and were skipped:\n` +
        missing.map((m) => `  - ${m}`).join("\n")
    );
  }

  if (copied === 0) {
    // Every nav page was missing on disk; refuse to ship the SDK with an empty docs bundle.
    throw new Error(`[bundleSdkDocs] 0 docs copied from the "${DROPDOWN}" nav; refusing empty docs bundle`);
  }

  console.log(
    `[bundleSdkDocs] bundled ${copied} docs from the "${DROPDOWN}" nav into ${path.relative(
      repoRoot,
      outDir
    )}`
  );
}

bundleSdkDocs().catch((e) => {
  console.error(e);
  process.exit(1);
});
