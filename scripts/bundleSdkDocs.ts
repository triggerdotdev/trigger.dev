import * as fs from "node:fs/promises";
import * as path from "node:path";

// Snapshots the curated docs that the bundled agent skills cite into the SDK package, so
// AI coding agents can read the version-pinned reference directly from node_modules
// (zero drift). Run as part of `@trigger.dev/sdk`'s build, from the package dir.
//
// The "manifest" is the union of every `sources:` entry across the SDK's bundled skills
// (skills/*/SKILL.md). The skill declares what it needs; the build copies exactly that.
// Add a `sources:` line to a skill and its doc ships automatically — nothing else to edit.
//
// Layout: a source `docs/tasks/overview.mdx` (relative to the repo root) is copied to
// `<sdk>/docs/tasks/overview.mdx`, so a skill at `<sdk>/skills/<name>/SKILL.md` reaches it
// at `../../docs/tasks/overview.mdx` and an agent reaches it at `@trigger.dev/sdk/docs/...`.

const packageDir = process.cwd(); // packages/trigger-sdk when run from the SDK build
const repoRoot = path.resolve(packageDir, "..", "..");
const skillsDir = path.join(packageDir, "skills");
const outDir = path.join(packageDir, "docs");

/** Pull the `sources:` list out of a SKILL.md YAML frontmatter block (simple line scan, no YAML dep). */
async function readSkillSources(skillMdPath: string): Promise<string[]> {
  const txt = await fs.readFile(skillMdPath, "utf8");
  const fm = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];

  const lines = fm[1].split(/\r?\n/);
  const sources: string[] = [];
  let inSources = false;

  for (const line of lines) {
    if (/^sources:\s*$/.test(line)) {
      inSources = true;
      continue;
    }
    if (inSources) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) {
        sources.push(item[1]);
        continue;
      }
      // A non-list, non-blank line ends the block (next top-level key).
      if (line.trim() !== "") break;
    }
  }

  return sources;
}

async function collectManifest(): Promise<string[]> {
  const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const all = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
    const sources = await readSkillSources(skillMd).catch(() => []);
    for (const s of sources) {
      // Only bundle docs paths; ignore anything that isn't a docs/*.mdx source.
      if (s.startsWith("docs/") && s.endsWith(".mdx")) all.add(s);
    }
  }

  return [...all].sort();
}

async function bundleSdkDocs() {
  const manifest = await collectManifest();

  if (manifest.length === 0) {
    // Fail the build rather than silently ship the SDK with stale or missing docs.
    throw new Error("[bundleSdkDocs] no doc sources found in skills/*/SKILL.md");
  }

  // Rebuild from scratch so removed sources don't linger in the package.
  await fs.rm(outDir, { recursive: true, force: true });

  const missing: string[] = [];
  let copied = 0;

  for (const rel of manifest) {
    const src = path.join(repoRoot, rel);
    try {
      await fs.access(src);
    } catch {
      missing.push(rel);
      continue;
    }
    // Strip the leading "docs/" so files land at <sdk>/docs/<subpath>.
    const dest = path.join(outDir, rel.slice("docs/".length));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    copied++;
  }

  if (missing.length > 0) {
    console.error(
      `[bundleSdkDocs] ${missing.length} doc source(s) cited by a skill do not exist:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\nFix the skill's sources: list or add the doc.`
    );
    process.exit(1);
  }

  console.log(`[bundleSdkDocs] bundled ${copied} docs into ${path.relative(repoRoot, outDir)}`);
}

bundleSdkDocs().catch((e) => {
  console.error(e);
  process.exit(1);
});
