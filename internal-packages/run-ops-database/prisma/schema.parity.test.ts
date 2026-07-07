import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Parses both the control-plane schema (`@trigger.dev/database`) and this
// dedicated run-ops schema, then diffs every SCALAR field of each run-subgraph
// model BIDIRECTIONALLY: a field present in either schema must exist in the
// other with matching type/nullability/array-ness/`@default`, since a run row
// must be writable to either physical database.
//
// Relation fields are excluded by design: the dedicated schema drops
// control-plane `@relation`s to control-plane-owned models and replaces the
// implicit many-to-many waitpoint relations with explicit FK-free join models
// (`TaskRunWaitpoint`, `WaitpointRunConnection`, `CompletedWaitpoint`). Only
// the scalar FK columns backing those relations (e.g. `projectId`) are
// compared; the relation object fields (e.g. `project`) are skipped.

const CONTROL_PLANE_SCHEMA_PATH = "../../database/prisma/schema.prisma";
const DEDICATED_SCHEMA_PATH = "./schema.prisma";

// Must never appear as a relation target in the dedicated schema.
const CONTROL_PLANE_ONLY_MODELS = [
  "Organization",
  "OrgMember",
  "Project",
  "RuntimeEnvironment",
  "User",
  "TaskSchedule",
  "BackgroundWorker",
  "BackgroundWorkerTask",
  "WorkerDeployment",
  "TaskQueue",
];

// Must have every scalar column reproduced in the dedicated schema.
const RUN_SUBGRAPH_MODELS = [
  "TaskRun",
  "TaskRunAttempt",
  "TaskRunExecutionSnapshot",
  "TaskRunWaitpoint",
  "TaskRunCheckpoint",
  "CheckpointRestoreEvent",
  "TaskRunTag",
  "Waitpoint",
  "WaitpointTag",
  "BatchTaskRun",
  "TaskRunDependency",
  "BatchTaskRunItem",
  "BatchTaskRunError",
  "Checkpoint",
];

function readSchema(rel: string): string {
  return readFileSync(resolve(__dirname, rel), "utf8");
}

// Strips `/* */` block comments and `//`/`///` line comments so prose mentioning
// model names can't false-match below. (Neither schema has `/*` inside a string.)
function stripComments(schema: string): string {
  return schema.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

type FieldInfo = {
  type: string;
  optional: boolean;
  array: boolean;
  default: string | null;
};

type ModelFields = Map<string, FieldInfo>;

// Prisma model blocks don't nest, so a lazy match to the next `}`-only line suffices.
function extractModelBlocks(schema: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)\n\}/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(schema))) {
    blocks.set(match[1], match[2]);
  }
  return blocks;
}

// Raw argument of `@default(...)`, honoring nested parens (`@default(cuid())`). Null if absent.
function extractDefault(attrs: string): string | null {
  const marker = "@default(";
  const idx = attrs.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length;
  let depth = 0;
  for (let i = start; i < attrs.length; i++) {
    if (attrs[i] === "(") {
      depth++;
    } else if (attrs[i] === ")") {
      if (depth === 0) return attrs.slice(start, i);
      depth--;
    }
  }
  return attrs.slice(start);
}

// Excludes relation fields: anything carrying `@relation`, plus back-relation fields
// (e.g. `checkpoints Checkpoint[]`) identified by their type being another model name.
// `unparsed` collects any content line the field regex fails to match, so a future
// multi-line field can never silently vanish from the diff.
function parseScalarFields(
  body: string,
  modelNames: Set<string>
): { fields: ModelFields; unparsed: string[] } {
  const fields: ModelFields = new Map();
  const unparsed: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("@@")) continue;
    const match = line.match(/^(\w+)\s+([A-Za-z_]\w*)(\[\])?(\?)?\s*(.*)$/);
    if (!match) {
      unparsed.push(line);
      continue;
    }
    const [, name, type, arrayMark, optionalMark, rest] = match;
    if (rest.includes("@relation")) continue;
    if (modelNames.has(type)) continue;
    fields.set(name, {
      type,
      array: arrayMark === "[]",
      optional: optionalMark === "?",
      default: extractDefault(rest),
    });
  }
  return { fields, unparsed };
}

function parseSchema(schema: string) {
  const stripped = stripComments(schema);
  const modelBlocks = extractModelBlocks(stripped);
  const modelNames = new Set(modelBlocks.keys());
  const models = new Map<string, ModelFields>();
  const unparsed: string[] = [];
  for (const [name, body] of modelBlocks) {
    const parsed = parseScalarFields(body, modelNames);
    models.set(name, parsed.fields);
    for (const line of parsed.unparsed) {
      unparsed.push(`${name}: ${line}`);
    }
  }
  return { models, modelNames, unparsed };
}

function describeField(field: FieldInfo | undefined): string {
  if (!field) return "<missing>";
  const array = field.array ? "[]" : "";
  const optional = field.optional ? "?" : "";
  const withDefault = field.default !== null ? ` @default(${field.default})` : "";
  return `${field.type}${array}${optional}${withDefault}`;
}

const controlPlane = parseSchema(readSchema(CONTROL_PLANE_SCHEMA_PATH));
const dedicated = parseSchema(readSchema(DEDICATED_SCHEMA_PATH));

describe("dedicated run-ops schema parity", () => {
  it("includes all 14 run-subgraph models in both schemas", () => {
    for (const model of RUN_SUBGRAPH_MODELS) {
      expect(Array.from(dedicated.modelNames)).toContain(model);
      expect(Array.from(controlPlane.modelNames)).toContain(model);
    }
  });

  it("fails on any content line the field parser doesn't recognise (no silent skips)", () => {
    // Scope the control-plane check to run-subgraph models so an unrelated control-plane schema
    // edit can't break this run-ops test; the dedicated schema contains only run-ops models.
    const inRunSubgraph = (entry: string) =>
      RUN_SUBGRAPH_MODELS.some((model) => entry.startsWith(`${model}: `));
    expect(controlPlane.unparsed.filter(inRunSubgraph)).toEqual([]);
    expect(dedicated.unparsed).toEqual([]);
  });

  it("reproduces every scalar column of each run-subgraph model bidirectionally with matching type/nullability/array/default", () => {
    const mismatches: string[] = [];

    for (const modelName of RUN_SUBGRAPH_MODELS) {
      const controlFields = controlPlane.models.get(modelName);
      const dedicatedFields = dedicated.models.get(modelName);
      if (!controlFields || !dedicatedFields) {
        mismatches.push(`${modelName}: model not found in one of the two schemas`);
        continue;
      }

      const fieldNames = new Set([...controlFields.keys(), ...dedicatedFields.keys()]);
      for (const fieldName of fieldNames) {
        const controlField = controlFields.get(fieldName);
        const dedicatedField = dedicatedFields.get(fieldName);

        if (!controlField) {
          mismatches.push(
            `${modelName}.${fieldName}: dedicated has ${describeField(
              dedicatedField
            )} but the control-plane schema has no such scalar field`
          );
          continue;
        }
        if (!dedicatedField) {
          mismatches.push(
            `${modelName}.${fieldName}: control-plane has ${describeField(
              controlField
            )} but the dedicated schema has no such scalar field`
          );
          continue;
        }

        const matches =
          dedicatedField.type === controlField.type &&
          dedicatedField.array === controlField.array &&
          dedicatedField.optional === controlField.optional &&
          dedicatedField.default === controlField.default;

        if (!matches) {
          mismatches.push(
            `${modelName}.${fieldName}: control-plane=${describeField(
              controlField
            )} dedicated=${describeField(dedicatedField)}`
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("references no control-plane model as a relation target", () => {
    const dedicatedText = stripComments(readSchema(DEDICATED_SCHEMA_PATH));
    for (const model of CONTROL_PLANE_ONLY_MODELS) {
      // A relation target appears as `  fieldName  Model @relation(...)`. A bare
      // scalar column like `projectId String` is fine; the model TYPE must be absent.
      const relationTarget = new RegExp(
        `@relation[^\\n]*\\b${model}\\b|\\b${model}\\b[^\\n]*@relation`
      );
      expect(dedicatedText).not.toMatch(relationTarget);
      expect(dedicatedText).not.toMatch(new RegExp(`\\s${model}(\\?|\\[\\])?\\s`));
    }
  });

  it("keeps the group-(A) waitpoint-block references FK-FREE (scalar columns / explicit FK-free join models)", () => {
    const dedicatedText = stripComments(readSchema(DEDICATED_SCHEMA_PATH));
    // TaskRunWaitpoint must NOT carry a `@relation` to Waitpoint/TaskRun/BatchTaskRun.
    const trw = dedicatedText.match(/model TaskRunWaitpoint \{[\s\S]*?\n\}/)![0];
    expect(trw).not.toMatch(/@relation/);
    expect(trw).toMatch(/waitpointId\s+String/);
    expect(trw).toMatch(/taskRunId\s+String/);
    // The two implicit M2M sets are replaced by explicit FK-free join models.
    expect(dedicatedText).toMatch(/model WaitpointRunConnection \{/);
    expect(dedicatedText).toMatch(/model CompletedWaitpoint \{/);
    const wrc = dedicatedText.match(/model WaitpointRunConnection \{[\s\S]*?\n\}/)![0];
    expect(wrc).not.toMatch(/@relation/);
    // Waitpoint completion back-refs are scalar, not relations.
    const wp = dedicatedText.match(/model Waitpoint \{[\s\S]*?\n\}/)![0];
    expect(wp).not.toMatch(/completedByTaskRun\s+TaskRun\s*\?\s*@relation/);
  });

  it("keeps the group-(B) co-resident references as real FKs (e.g. TaskRunAttempt.taskRun)", () => {
    const dedicatedText = stripComments(readSchema(DEDICATED_SCHEMA_PATH));
    const attempt = dedicatedText.match(/model TaskRunAttempt \{[\s\S]*?\n\}/)![0];
    // The attempt->run relation stays a real FK (always co-resident).
    expect(attempt).toMatch(/taskRun\s+TaskRun\s+@relation/);
  });
});
