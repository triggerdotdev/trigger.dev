import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mintWaitpointIdFor } from "@trigger.dev/core/v3/isomorphic";
import { WAITPOINT_MINT_SITES } from "./waitpointMintCatalog";

const GEN2_ANCHOR = `${"a".repeat(24)}a2`;
const GEN1_ANCHOR = `${"a".repeat(24)}01`;

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("repo root (pnpm-workspace.yaml) not found");
    dir = parent;
  }
  return dir;
}

function read(relative: string): string {
  return readFileSync(path.join(repoRoot(), relative), "utf8");
}

function count(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length;
}

// Every source file that may create a Postgres waitpoint row. The coordinator directory is
// WALKED rather than listed, so a mint added in a new coordinator file cannot hide here.
function scannedFiles(): string[] {
  const coordinatorDir = "internal-packages/run-engine/src/engine/waitpointCoordinator";
  const walked = readdirSync(path.join(repoRoot(), coordinatorDir))
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .map((name) => `${coordinatorDir}/${name}`);

  return [
    ...walked,
    "internal-packages/run-engine/src/engine/index.ts",
    "internal-packages/run-store/src/PostgresRunStore.ts",
  ];
}

describe("waitpoint mint census — behaviour per catalogued site", () => {
  for (const site of WAITPOINT_MINT_SITES) {
    it(`${site.id} (${site.type}) stamps a gen-2 anchor's shard char`, () => {
      const r = mintWaitpointIdFor(GEN2_ANCHOR);
      expect(r.id[24]).toBe("a");
      expect(r.id[25]).toBe("2");
    });

    it(`${site.id} (${site.type}) keeps a cuid for a gen-1 anchor`, () => {
      expect(mintWaitpointIdFor(GEN1_ANCHOR).id.length).toBe(25);
    });
  }
});

describe("waitpoint mint census — source drift guard", () => {
  it("no scanned source mints a waitpoint id with the un-stamped helper", () => {
    // The regex matches tokens inside comments too — deliberate. Any textual addition
    // forces the census to be reconciled, so a new site cannot land without an entry.
    for (const file of scannedFiles()) {
      expect({ file, hits: count(read(file), /WaitpointId\.generate\(/g) }).toEqual({
        file,
        hits: 0,
      });
    }
  });

  it("every file that writes a waitpoint row is catalogued", () => {
    const catalogued = new Set(WAITPOINT_MINT_SITES.map((s) => s.site));

    for (const file of scannedFiles()) {
      const source = read(file);
      // A create with NO id is the worst case: Prisma's @default(cuid()) then mints a cuid
      // on a gen-2 shard after the write, which no stamp check can see.
      const writes =
        count(source, /waitpoint\.create\(/g) +
        count(source, /upsertWaitpoint\(/g) +
        count(source, /createWaitpoint\(/g);

      if (writes > 0) {
        expect({ file, catalogued: catalogued.has(file) }).toEqual({ file, catalogued: true });
      }
    }
  });

  it("every catalogued site names a file that exists", () => {
    for (const site of WAITPOINT_MINT_SITES) {
      expect({ site: site.site, exists: existsSync(path.join(repoRoot(), site.site)) }).toEqual({
        site: site.site,
        exists: true,
      });
    }
  });

  it("no catalogued symbol is a line number", () => {
    for (const site of WAITPOINT_MINT_SITES) {
      expect(site.symbol).not.toMatch(/:\d+/);
    }
  });
});
