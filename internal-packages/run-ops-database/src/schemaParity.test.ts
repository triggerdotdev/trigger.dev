import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the double-authoring rule for run-graph schema changes.
 *
 * The run-ops database is on its own migration history, so a change to a run-graph model has to be
 * written twice: once in `@trigger.dev/database` (which targets the control-plane and legacy RDS
 * databases) and once here. Nothing about the two histories forces that, and when it is missed the
 * run-ops status job truthfully reports "up to date" against its own history — so the change simply
 * never lands, silently.
 *
 * This compares the PHYSICAL shape of every model the run-ops schema declares against its
 * control-plane counterpart: scalar fields with their attributes, plus `@@index` / `@@unique` /
 * `@@id` / `@@map`. Relation navigation fields are excluded, because the run-ops schema deliberately
 * drops relations that would cross into the control-plane database while keeping the scalar FK
 * column.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_OPS_SCHEMA = resolve(packageRoot, "prisma/schema.prisma");
const CONTROL_PLANE_SCHEMA = resolve(packageRoot, "../database/prisma/schema.prisma");

/**
 * Models that exist only in the run-ops schema, with no control-plane counterpart to compare
 * against. Both replace a control-plane implicit many-to-many relation with an explicit, FK-free
 * join model, because an implicit m2m carries a foreign key that cannot resolve across databases.
 */
const RUN_OPS_ONLY_MODELS = new Set(["CompletedWaitpoint", "WaitpointRunConnection"]);

type Schema = {
  models: Map<string, string[]>;
  modelNames: Set<string>;
};

function parseSchema(path: string): Schema {
  const lines = readFileSync(path, "utf8").split("\n");
  const models = new Map<string, string[]>();
  let current: string | null = null;
  let body: string[] = [];

  for (const line of lines) {
    const open = line.match(/^model\s+(\w+)\s*\{/);
    if (open) {
      current = open[1]!;
      body = [];
      continue;
    }
    if (current !== null && /^\}/.test(line)) {
      models.set(current, body);
      current = null;
      continue;
    }
    if (current !== null) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("//")) {
        body.push(trimmed);
      }
    }
  }

  return { models, modelNames: new Set(models.keys()) };
}

/**
 * Keeps the lines that describe physical database structure and drops the ones that describe Prisma
 * relations. A field is a relation navigation field when its type resolves to a model, so scalar FK
 * columns (`String`) and enum-typed columns are both retained.
 */
function physicalLines(body: string[], modelNames: Set<string>): Set<string> {
  const kept = new Set<string>();

  for (const line of body) {
    if (line.startsWith("@@")) {
      if (/^@@(index|unique|id|map)\b/.test(line)) {
        kept.add(line.replace(/\s+/g, " "));
      }
      continue;
    }

    const field = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?/);
    if (!field) continue;

    const [, , type] = field;
    if (modelNames.has(type!)) continue;
    if (line.includes("@relation(")) continue;

    kept.add(line.replace(/\s+/g, " "));
  }

  return kept;
}

describe("run-ops schema parity with the control-plane schema", () => {
  const runOps = parseSchema(RUN_OPS_SCHEMA);
  const controlPlane = parseSchema(CONTROL_PLANE_SCHEMA);

  const sharedModels = [...runOps.models.keys()]
    .filter((name) => !RUN_OPS_ONLY_MODELS.has(name))
    .sort();

  it("finds models to compare", () => {
    expect(sharedModels.length).toBeGreaterThan(10);
  });

  it("declares every run-ops-only model in the exception list, and no others", () => {
    const missingFromControlPlane = [...runOps.models.keys()]
      .filter((name) => !controlPlane.models.has(name))
      .sort();

    expect(missingFromControlPlane).toEqual([...RUN_OPS_ONLY_MODELS].sort());
  });

  it.each(sharedModels)("%s has the same physical shape in both schemas", (modelName) => {
    const runOpsBody = runOps.models.get(modelName);
    const controlPlaneBody = controlPlane.models.get(modelName);

    expect(runOpsBody, `${modelName} missing from the run-ops schema`).toBeDefined();
    expect(controlPlaneBody, `${modelName} missing from the control-plane schema`).toBeDefined();

    const runOpsShape = physicalLines(runOpsBody!, runOps.modelNames);
    const controlPlaneShape = physicalLines(controlPlaneBody!, controlPlane.modelNames);

    const onlyInControlPlane = [...controlPlaneShape].filter((l) => !runOpsShape.has(l)).sort();
    const onlyInRunOps = [...runOpsShape].filter((l) => !controlPlaneShape.has(l)).sort();

    expect(
      { onlyInControlPlane, onlyInRunOps },
      `${modelName} differs physically between the two schemas. A run-graph change was written to ` +
        `one schema and not the other; add the missing side plus a migration in that package.`
    ).toEqual({ onlyInControlPlane: [], onlyInRunOps: [] });
  });
});
