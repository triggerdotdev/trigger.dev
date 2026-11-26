import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routeAccess, specFiles, specOperations } from "../scripts/api-access.mjs";

type Operation = { method: string; path: string; declared?: string };

// Catches: an API page showing (or a docs key being created for) access that the route doesn't
// check, after a route's authorization or the spec changes. Fix with `node scripts/api-access.mjs`.
describe.each(specFiles as string[])("x-trigger-access in %s", (file) => {
  const operations = specOperations(readFileSync(file, "utf8")) as Operation[];

  it.each(operations.map((op) => [`${op.method.toUpperCase()} ${op.path}`, op]))(
    "%s matches its route",
    (_name, op) => {
      const access = routeAccess(op.method, op.path);
      expect(
        access,
        `can't read the route's access; add it to OVERRIDES in scripts/api-access.mjs`
      ).not.toBeUndefined();
      expect(op.declared ?? null, `${path.basename(file)}: run node scripts/api-access.mjs`).toBe(
        access
      );
    }
  );
});
