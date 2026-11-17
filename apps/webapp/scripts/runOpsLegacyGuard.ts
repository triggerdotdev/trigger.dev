/**
 * Track-1 run-ops legacy guard (type-aware inventory) — SOURCE OF TRUTH for the three-DB-split
 * "Track 1" sweep. Builds one `ts.Program` over the webapp tsconfig, with the source files of the
 * other COVERED_ROOTS added, and uses the TypeChecker to resolve receiver types, catching aliased
 * control-plane clients that grep/oxlint cannot.
 *
 * The run-graph models are the models of every schema in RUN_GRAPH_SCHEMA_PATHS; the run-graph
 * tables are their tables plus the join tables of their many-to-many relations. Scope is
 * COVERED_ROOTS minus the run store, schema and testcontainers packages, test code, local seed
 * scripts and generated output (see isInScope).
 *
 *   Detector (i)   — a call to a run-graph model's read/write method whose receiver resolves BY TYPE
 *                    to the control-plane or a run-ops Prisma client: directly, through a
 *                    transaction handle, or through a variable holding the model accessor.
 *   Detector (ii)  — an include/select of a relation crossing the run-graph <-> control-plane seam
 *                    (relation set derived by parsing both schema.prisma files).
 *   Detector (iii) — a control-plane client assigned to a run-ops read-through slot.
 *   Detector (iv)  — a $queryRaw/$executeRaw(Unsafe) call on a database client whose SQL names a
 *                    run-graph table in double quotes.
 *
 * Markers: an allowed exception carries a single-line comment
 *   // runops-exception(<OWNER>): <reason>
 * directly above the statement or arrow function body that holds the access (<OWNER> is a short
 * lower-case name for the piece of work that will remove the access, for example
 * `batches-migration` or `legacy-teardown`). It honours every finding in that unit and is recorded
 * in the baseline's `markers`. Both modes fail on a malformed marker or one that covers no finding (off
 * target); `--check` also fails on a recorded marker that is no longer found (stale) or a found
 * marker that is not recorded (unrecorded).
 *
 * Modes: default regenerates the baseline; `--check` fails (exit 1) on any violation not baselined.
 *   pnpm --filter webapp run guard:runops-legacy            # regenerate baseline
 *   pnpm --filter webapp run guard:runops-legacy -- --check # CI gate
 */
import ts from "typescript-legacy-api";
import * as fs from "node:fs";
import * as path from "node:path";
import { findRepoRoot } from "./lib/repoRoot";

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = findRepoRoot(process.cwd());
const WEBAPP_DIR = path.join(REPO_ROOT, "apps", "webapp");
const TSCONFIG_PATH = path.join(WEBAPP_DIR, "tsconfig.check.json");
const CP_SCHEMA = path.join(REPO_ROOT, "internal-packages", "database", "prisma", "schema.prisma");
const RUNOPS_SCHEMA = path.join(
  REPO_ROOT,
  "internal-packages",
  "run-ops-database",
  "prisma",
  "schema.prisma"
);
const BASELINE_PATH = path.join(WEBAPP_DIR, "app", "v3", "runOpsMigration", "track1-baseline.json");

// The run-graph schemas (repository-relative). Every model of a listed schema is a run-graph model,
// and its generated client counts as the run-ops client. A new run-graph store adds its schema here.
const RUN_GRAPH_SCHEMA_PATHS = ["internal-packages/run-ops-database/prisma/schema.prisma"];
const RUN_GRAPH_SCHEMAS = RUN_GRAPH_SCHEMA_PATHS.map((p) => path.join(REPO_ROOT, p));

const CP_PACKAGE_DIR = path.dirname(path.dirname(CP_SCHEMA));
const RUNOPS_PACKAGE_DIR = path.dirname(path.dirname(RUNOPS_SCHEMA));
const RUN_GRAPH_PACKAGE_DIRS = RUN_GRAPH_SCHEMAS.map((s) => path.dirname(path.dirname(s)));

/** Absolute path of the generated Prisma client for a schema, from its generator `output = "..."`. */
function generatedClientDir(schemaFile: string): string {
  const m = /^\s*output\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(schemaFile, "utf8"));
  if (!m) {
    console.error(`No generator output path found in ${schemaFile}`);
    process.exit(2);
  }
  return path.resolve(path.dirname(schemaFile), m[1]);
}

const CP_GENERATED_DIR = generatedClientDir(CP_SCHEMA);
const RUN_GRAPH_GENERATED_DIRS = RUN_GRAPH_SCHEMAS.map(generatedClientDir);

function realpathIfExists(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Classification roots, realpath'd to match the checker's realpath'd file names.
const RUNOPS_DECL_DIRS = [...RUN_GRAPH_GENERATED_DIRS, ...RUN_GRAPH_PACKAGE_DIRS].map(
  realpathIfExists
);
const CP_DECL_DIRS = [CP_GENERATED_DIR, CP_PACKAGE_DIR].map(realpathIfExists);

// Both client packages are force-resolved to SOURCE (src/ + generated client) when building the
// program, so classification never depends on a built/fresh `dist/` in the running environment.
const FORCED_TYPE_RESOLUTIONS = new Map<string, string>([
  ["@trigger.dev/database", path.join(CP_PACKAGE_DIR, "src", "index.ts")],
  ["@internal/run-ops-database", path.join(RUNOPS_PACKAGE_DIR, "src", "index.ts")],
]);

// Scope (repository-relative paths): a file under a covered root, minus the exclusions below.
const COVERED_ROOTS = [
  "apps/webapp/",
  "internal-packages/run-engine/",
  "internal-packages/schedule-engine/",
  "internal-packages/webhook-engine/",
  "internal-packages/rbac/",
  "internal-packages/sso/",
  "internal-packages/llm-model-catalog/",
  "packages/core/",
  "scripts/",
];
// The run store and the schema packages are not judged; testcontainers builds throwaway test DBs.
const EXCLUDED_PACKAGE_DIRS = [
  "internal-packages/run-store/",
  "internal-packages/testcontainers/",
  ...[CP_PACKAGE_DIR, ...RUN_GRAPH_PACKAGE_DIRS].map((d) => repoRel(d) + "/"),
];
// Not `build`: packages/core/src/v3/build/ is source; build output is JS the program does not take.
const EXCLUDED_DIR_NAMES = new Set([
  "test",
  "tests",
  "generated",
  "dist",
  "node_modules",
  "migrations",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Prisma method classification
// ─────────────────────────────────────────────────────────────────────────────

const READ_METHODS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

type CallKind = "read" | "write";

function methodKind(name: string): CallKind | undefined {
  if (READ_METHODS.has(name)) return "read";
  if (WRITE_METHODS.has(name)) return "write";
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema parsing (derive run-graph models + cross-seam relations)
// ─────────────────────────────────────────────────────────────────────────────

const PRISMA_SCALARS = new Set([
  "String",
  "Boolean",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "DateTime",
  "Json",
  "Bytes",
]);

type SchemaField = { name: string; baseType: string; list: boolean; relationName?: string };
type SchemaModel = { name: string; table: string; fields: SchemaField[] };

function parseSchemaModels(file: string): Map<string, SchemaModel> {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const models = new Map<string, SchemaModel>();
  let current: SchemaModel | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const modelStart = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
    if (modelStart) {
      current = { name: modelStart[1], table: modelStart[1], fields: [] };
      models.set(current.name, current);
      continue;
    }
    if (!current) continue;
    if (line === "}") {
      current = null;
      continue;
    }
    const mapMatch = /^@@map\(\s*"([^"]+)"/.exec(line);
    if (mapMatch) current.table = mapMatch[1];
    if (!line || line.startsWith("//") || line.startsWith("@@") || line.startsWith("/")) continue;

    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*(?:\[\])?\??)/.exec(
      line
    );
    if (!fieldMatch) continue;
    const fieldName = fieldMatch[1];
    const baseType = fieldMatch[2].replace(/[?[\]]/g, "");
    const relationName = /@relation\(\s*(?:name\s*:\s*)?"([^"]+)"/.exec(line)?.[1];
    current.fields.push({
      name: fieldName,
      baseType,
      list: fieldMatch[2].endsWith("[]"),
      relationName,
    });
  }
  return models;
}

function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

const runGraphSchemaModels = RUN_GRAPH_SCHEMAS.map(parseSchemaModels);
const RUN_GRAPH_MODELS = new Set(runGraphSchemaModels.flatMap((m) => Array.from(m.keys())));
const RUN_GRAPH_DELEGATES = new Set(Array.from(RUN_GRAPH_MODELS, lowerFirst));

const cpModels = parseSchemaModels(CP_SCHEMA);

// Run-graph tables, matched (double-quoted) in raw SQL: each run-graph model's table, plus the
// implicit join table of every many-to-many relation that touches a run-graph model.
const runGraphTableSet = new Set<string>();
for (const models of runGraphSchemaModels) {
  for (const m of models.values()) runGraphTableSet.add(m.table);
}
for (const models of [cpModels, ...runGraphSchemaModels]) {
  for (const m of models.values()) {
    for (const f of m.fields) {
      if (!f.list) continue;
      const back = models
        .get(f.baseType)
        ?.fields.find(
          (b) => b !== f && b.list && b.baseType === m.name && b.relationName === f.relationName
        );
      if (!back) continue;
      if (!RUN_GRAPH_MODELS.has(m.name) && !RUN_GRAPH_MODELS.has(f.baseType)) continue;
      runGraphTableSet.add("_" + (f.relationName ?? [m.name, f.baseType].sort().join("To")));
    }
  }
}
const RUN_GRAPH_TABLES = Array.from(runGraphTableSet).sort();
const cpModelNames = new Set(cpModels.keys());
const enumAndScalar = (baseType: string) =>
  PRISMA_SCALARS.has(baseType) || !cpModelNames.has(baseType);

// model -> (relationFieldName -> targetModel), for every relation in the control-plane schema.
const relationFieldsByModel = new Map<string, Map<string, string>>();
// model -> set of relation field names that cross the run-graph/control-plane seam.
const crossSeamRelationsByModel = new Map<string, Set<string>>();
const crossSeamRelationList: string[] = [];

for (const model of cpModels.values()) {
  const rels = new Map<string, string>();
  const crosses = new Set<string>();
  for (const field of model.fields) {
    if (enumAndScalar(field.baseType)) continue; // scalar or enum, not a relation
    rels.set(field.name, field.baseType);
    const ownerIsRun = RUN_GRAPH_MODELS.has(model.name);
    const targetIsRun = RUN_GRAPH_MODELS.has(field.baseType);
    if (ownerIsRun !== targetIsRun) {
      crosses.add(field.name);
      crossSeamRelationList.push(`${model.name}.${field.name}`);
    }
  }
  relationFieldsByModel.set(model.name, rels);
  if (crosses.size) crossSeamRelationsByModel.set(model.name, crosses);
}
crossSeamRelationList.sort();

// camelCase delegate -> control-plane model name (every control-plane model).
const delegateToModel = new Map<string, string>();
for (const name of cpModelNames) delegateToModel.set(lowerFirst(name), name);

// Detector (iii): read-through config slots that MUST carry a run-ops client. Assigning a
// control-plane client here (e.g. `legacyReplica: $replica`) is invisible to the type-aware
// detectors — the field is typed RunOpsPrismaClient but the value is coerced in — yet it makes
// legacy-resident reads hit the control-plane DB (a 404 once legacy is a separate database).
// `controlPlaneReplica` is deliberately NOT listed: it is meant to be a control-plane client.
const RUN_OPS_READTHROUGH_SLOTS = new Set([
  "newClient",
  "newReplica",
  "runOpsNew",
  "legacyReplica",
  "runOpsLegacyReplica",
]);
const CONTROL_PLANE_CLIENT_IDENTIFIERS = new Set(["$replica", "prisma"]);

// The text of a marker comment; a comment that starts with the tag but does not match is malformed.
const MARKER_TAG = "runops-exception";
const MARKER_PATTERN = /^\/\/\s*runops-exception\(([a-z][a-z0-9-]*)\):\s*(\S.*?)\s*$/;

// ─────────────────────────────────────────────────────────────────────────────
// Program construction
// ─────────────────────────────────────────────────────────────────────────────

function buildProgram(): ts.Program {
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    getCurrentDirectory: () => WEBAPP_DIR,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      process.exit(2);
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(TSCONFIG_PATH, undefined, host);
  if (!parsed) throw new Error(`Failed to parse ${TSCONFIG_PATH}`);
  // Resolve workspace packages from source (tsconfig.check.json blanks this to target built dists,
  // which may not exist here), and pin the two client packages to their src entrypoints —
  // @trigger.dev/database has no exports map, so the condition alone cannot redirect it.
  const options: ts.CompilerOptions = {
    ...parsed.options,
    customConditions: ["@triggerdotdev/source"],
  };
  const compilerHost = ts.createCompilerHost(options);
  const resolutionCache = ts.createModuleResolutionCache(
    compilerHost.getCurrentDirectory(),
    (f) => compilerHost.getCanonicalFileName(f),
    options
  );
  compilerHost.resolveModuleNameLiterals = (moduleLiterals, containingFile, redirected, opts) =>
    moduleLiterals.map((lit) => {
      const forced = FORCED_TYPE_RESOLUTIONS.get(lit.text);
      if (forced) {
        return {
          resolvedModule: {
            resolvedFileName: forced,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          },
        };
      }
      return ts.resolveModuleName(
        lit.text,
        containingFile,
        opts,
        compilerHost,
        resolutionCache,
        redirected
      );
    });
  const walked = COVERED_ROOTS.filter((r) => r !== "apps/webapp/")
    .flatMap((r) =>
      ts.sys.readDirectory(
        path.join(REPO_ROOT, r),
        [".ts", ".tsx", ".mts", ".cts"],
        ["**/node_modules", "**/dist"]
      )
    )
    .filter((f) => !/\.d\.[mc]?ts$/.test(f) && isInScope(repoRel(f)));
  return ts.createProgram({
    rootNames: [...parsed.fileNames, ...walked],
    options,
    host: compilerHost,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Type classification
// ─────────────────────────────────────────────────────────────────────────────

type ClientKind = "cp" | "runops" | "other";

function underDir(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Absolute-dir match against the two packages first (environment-independent); substring match is
// only a fallback for non-workspace layouts (pnpm store paths) and the virtual self-test files.
function declFileKind(fileName: string): ClientKind | undefined {
  const abs = path.resolve(fileName);
  if (RUNOPS_DECL_DIRS.some((d) => underDir(abs, d))) return "runops";
  if (CP_DECL_DIRS.some((d) => underDir(abs, d))) return "cp";
  const f = fileName.split(path.sep).join("/");
  if (f.includes("run-ops-database")) return "runops";
  if (f.includes("internal-packages/database")) return "cp";
  if (f.includes("@trigger.dev/database")) return "cp";
  return undefined;
}

/** Classify the resolved type of a `receiver.delegate` access. A union that contains any
 *  control-plane leg classifies as "cp" (the control-plane leg is the migration hazard — this is
 *  what flags `runOpsLegacyReplica ?? this._replica` and similar fallback expressions). */
function classifyType(checker: ts.TypeChecker, t: ts.Type, seen = new Set<ts.Type>()): ClientKind {
  const kinds = collectKinds(t, seen);
  if (kinds.has("cp")) return "cp";
  if (kinds.has("runops")) return "runops";
  return "other";
}

function collectKinds(t: ts.Type, seen: Set<ts.Type>): Set<ClientKind> {
  const out = new Set<ClientKind>();
  if (seen.has(t)) return out;
  seen.add(t);
  if (t.isUnion() || t.isIntersection()) {
    for (const sub of (t as ts.UnionOrIntersectionType).types) {
      for (const k of collectKinds(sub, seen)) out.add(k);
    }
    return out;
  }
  const sym = t.getSymbol() ?? t.aliasSymbol;
  const decls = sym?.getDeclarations() ?? [];
  for (const d of decls) {
    const kind = declFileKind(d.getSourceFile().fileName);
    if (kind) out.add(kind);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST helpers
// ─────────────────────────────────────────────────────────────────────────────

function propName(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
    const n = prop.name;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  }
  return undefined;
}

/** Resolve an expression to an ObjectLiteralExpression, unwrapping parens / `as` / `satisfies`
 *  and following simple in-file `const foo = { ... }` identifier references. */
function toObjectLiteral(
  checker: ts.TypeChecker,
  node: ts.Expression | undefined,
  seen = new Set<ts.Node>()
): ts.ObjectLiteralExpression | undefined {
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isParenthesizedExpression(node)) return toObjectLiteral(checker, node.expression, seen);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return toObjectLiteral(checker, node.expression, seen);
  }
  if (ts.isIdentifier(node)) {
    const sym = checker.getSymbolAtLocation(node);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return toObjectLiteral(checker, decl.initializer, seen);
    }
  }
  return undefined;
}

/** The run-graph model whose generated `<Model>Delegate` type a call's receiver has, whatever holds
 *  it (`client.taskRun`, a variable, a destructured name, a parameter, a field). The caller checks
 *  with classifyType that the type is declared in a generated client. */
function runGraphDelegateModel(t: ts.Type): string | undefined {
  for (const sub of t.isUnion() ? t.types : [t]) {
    const model = /^(\w+)Delegate$/.exec((sub.getSymbol() ?? sub.aliasSymbol)?.getName() ?? "");
    if (model && RUN_GRAPH_MODELS.has(model[1])) return model[1];
  }
  return undefined;
}

const RAW_QUERY_METHODS = new Set([
  "$queryRaw",
  "$executeRaw",
  "$queryRawUnsafe",
  "$executeRawUnsafe",
]);
const PRISMA_SQL_HELPERS = new Set(["sql", "raw", "join"]);

function isPrismaSqlHelper(e: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "Prisma" &&
    PRISMA_SQL_HELPERS.has(e.name.text)
  );
}

/** Parentheses and type assertions around SQL do not change it. */
function unwrapSqlExpression(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** A value bound into a tagged template or a `Prisma.join` list is data, not SQL, unless it is
 *  itself a `Prisma.sql` / `Prisma.raw` / `Prisma.join` fragment (or a list of them). */
function collectSqlFromBoundValue(node: ts.Node, out: string[]): void {
  const e = unwrapSqlExpression(node);
  if (ts.isArrayLiteralExpression(e)) {
    for (const el of e.elements) collectSqlFromBoundValue(el, out);
  } else if (
    (ts.isCallExpression(e) && isPrismaSqlHelper(e.expression)) ||
    (ts.isTaggedTemplateExpression(e) && isPrismaSqlHelper(e.tag))
  ) {
    collectSqlText(e, out);
  }
}

/** The SQL text of a raw query argument: its string literals and template parts, and those of the
 *  `Prisma.sql` / `Prisma.raw` / `Prisma.join` calls nested in it. Identifiers are not followed. */
function collectSqlText(node: ts.Node, out: string[]): void {
  node = unwrapSqlExpression(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node.text);
  } else if (ts.isTemplateExpression(node)) {
    out.push(node.head.text);
    for (const span of node.templateSpans) {
      out.push(span.literal.text);
      if (ts.isTaggedTemplateExpression(node.parent))
        collectSqlFromBoundValue(span.expression, out);
      else collectSqlText(span.expression, out);
    }
  } else if (ts.isTaggedTemplateExpression(node) && isPrismaSqlHelper(node.tag)) {
    collectSqlText(node.template, out);
  } else if (ts.isCallExpression(node) && isPrismaSqlHelper(node.expression)) {
    const helper = node.expression;
    // Prisma.join's first argument is a list of bound values; its separator, prefix and suffix are SQL.
    node.arguments.forEach((a, i) =>
      ts.isPropertyAccessExpression(helper) && helper.name.text === "join" && i === 0
        ? collectSqlFromBoundValue(a, out)
        : collectSqlText(a, out)
    );
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const e of node.elements) collectSqlText(e, out);
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    collectSqlText(node.left, out);
    collectSqlText(node.right, out);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Violations
// ─────────────────────────────────────────────────────────────────────────────

type Violation = {
  file: string; // repo-relative, forward slashes
  line: number; // 1-based
  model: string;
  delegate: string;
  callKind: CallKind;
  detector: "i" | "ii" | "iii" | "iv";
  snippet: string;
};

/** True if `expr` is syntactically a control-plane client: the `$replica`/`prisma` exports, or a
 *  `this._replica`/`this._prisma` BaseService field. Used by detector (iii) — deliberately name-based
 *  (not type-based) because the control-plane and run-ops client TYPES are identical after erasure. */
function valueIsControlPlaneClient(node: ts.Expression): boolean {
  let e: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  if (ts.isIdentifier(e)) return CONTROL_PLANE_CLIENT_IDENTIFIERS.has(e.text);
  if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return e.name.text === "_replica" || e.name.text === "_prisma";
  }
  return false;
}

function violationKey(v: Violation): string {
  return [v.file, v.line, v.detector, v.model, v.delegate, v.callKind].join("::");
}

// An honoured marker, recorded in the baseline; `line` is the marker comment's line.
type Marker = { file: string; line: number; owner: string; reason: string; findings: string[] };
// A malformed or off-target marker. Never baselined; fails both modes.
type MarkerError = { file: string; line: number; kind: "malformed" | "off target"; text: string };

type ScanResult = {
  violations: Violation[];
  markers: Marker[];
  markerErrors: MarkerError[];
};

function markerKey(m: Marker): string {
  // No line: a change that only moves lines above a marked access is not drift.
  return [m.file, m.owner, m.reason, m.findings.join(",")].join("::");
}

/** The words `--check` prints for a finding, e.g. `iv/read TaskRun.$queryRaw`. */
/** Recorded and found markers compared as multisets: two markers with one key (file, owner,
 *  reason, findings) must both be found. */
function compareMarkers(
  recorded: Marker[],
  found: Marker[]
): { stale: Marker[]; unrecorded: Marker[] } {
  const groupByKey = (ms: Marker[]) => {
    const out = new Map<string, Marker[]>();
    for (const m of ms) out.set(markerKey(m), [...(out.get(markerKey(m)) ?? []), m]);
    return out;
  };
  const recordedByKey = groupByKey(recorded);
  const foundByKey = groupByKey(found);
  const stale = Array.from(recordedByKey).flatMap(([k, ms]) =>
    ms.slice(foundByKey.get(k)?.length ?? 0)
  );
  const unrecorded = Array.from(foundByKey).flatMap(([k, ms]) =>
    ms.slice(recordedByKey.get(k)?.length ?? 0)
  );
  return { stale, unrecorded };
}

function findingLabel(v: Violation): string {
  return `${v.detector}/${v.callKind} ${v.model}.${v.delegate}`;
}

/** The unit a finding's node belongs to: the nearest arrow function expression body, or statement
 *  of a source file, block, module block or case/default clause. A marker covers one unit. */
function unitOf(node: ts.Node): ts.Node {
  let n = node;
  while (n.parent) {
    const p = n.parent;
    if (ts.isArrowFunction(p) && p.body === n && !ts.isBlock(n)) return n;
    if (
      (ts.isSourceFile(p) ||
        ts.isBlock(p) ||
        ts.isModuleBlock(p) ||
        ts.isCaseClause(p) ||
        ts.isDefaultClause(p)) &&
      p.statements.some((s) => s === n)
    ) {
      return n;
    }
    n = p;
  }
  return n;
}

/** Every `//` comment in the file whose text starts with the marker tag, from the parsed tree's
 *  tokens (so marker-shaped text in a string or template literal is not a comment). */
function markerComments(sf: ts.SourceFile): ts.CommentRange[] {
  const byPos = new Map<number, ts.CommentRange>();
  const walk = (n: ts.Node): void => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length) return kids.forEach(walk);
    for (const r of [
      ...(ts.getLeadingCommentRanges(sf.text, n.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(sf.text, n.getEnd()) ?? []),
    ]) {
      byPos.set(r.pos, r);
    }
  };
  walk(sf);
  return Array.from(byPos.values())
    .filter(
      (r) =>
        r.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
        new RegExp("^//\\s*" + MARKER_TAG).test(sf.text.slice(r.pos, r.end))
    )
    .sort((a, b) => a.pos - b.pos);
}

function repoRel(fileName: string): string {
  return path.relative(REPO_ROOT, fileName).split(path.sep).join("/");
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return lineOfPos(sf, node.getStart(sf));
}

function lineOfPos(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function lineText(sf: ts.SourceFile, line1: number): string {
  const starts = sf.getLineStarts();
  const idx = line1 - 1;
  const start = starts[idx];
  const end = idx + 1 < starts.length ? starts[idx + 1] : sf.text.length;
  return sf.text.slice(start, end).trim().slice(0, 200);
}

/** The scope rule, over a repository-relative path with forward slashes. */
function isInScope(rel: string, roots: string[] = COVERED_ROOTS): boolean {
  if (!roots.some((r) => rel.startsWith(r))) return false;
  if (EXCLUDED_PACKAGE_DIRS.some((d) => rel.startsWith(d))) return false;
  const dirs = rel.split("/");
  const name = dirs.pop()!;
  if (/\.test\.(ts|tsx|mts|cts)$/.test(name)) return false;
  if (dirs.some((d) => EXCLUDED_DIR_NAMES.has(d))) return false;
  // Local seed scripts.
  if (dirs.join("/") === "apps/webapp" && name.startsWith("seed")) return false;
  if (rel === "apps/webapp/prisma/populate.ts") return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detector (ii): cross-seam relation walk
// ─────────────────────────────────────────────────────────────────────────────

type CrossSeamHit = { keyNode: ts.Node; ownerModel: string; relation: string };

function walkSelectionMap(
  checker: ts.TypeChecker,
  obj: ts.ObjectLiteralExpression,
  model: string,
  hits: CrossSeamHit[]
): void {
  const rels = relationFieldsByModel.get(model);
  const crosses = crossSeamRelationsByModel.get(model);
  for (const prop of obj.properties) {
    const key = propName(prop);
    if (!key) continue;
    if (crosses?.has(key)) {
      const keyNode =
        ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) ? prop.name : prop;
      hits.push({ keyNode, ownerModel: model, relation: key });
    }
    const target = rels?.get(key);
    if (target && ts.isPropertyAssignment(prop)) {
      const nested = toObjectLiteral(checker, prop.initializer);
      if (nested) walkRelationArgs(checker, nested, target, hits);
    }
  }
}

function walkRelationArgs(
  checker: ts.TypeChecker,
  obj: ts.ObjectLiteralExpression,
  model: string,
  hits: CrossSeamHit[]
): void {
  for (const prop of obj.properties) {
    const key = propName(prop);
    if ((key === "select" || key === "include") && ts.isPropertyAssignment(prop)) {
      const nested = toObjectLiteral(checker, prop.initializer);
      if (nested) walkSelectionMap(checker, nested, model, hits);
    }
  }
}

function collectCrossSeamHits(
  checker: ts.TypeChecker,
  argExpr: ts.Expression | undefined,
  rootModel: string
): CrossSeamHit[] {
  const hits: CrossSeamHit[] = [];
  const argObj = toObjectLiteral(checker, argExpr);
  if (!argObj) return hits;
  for (const prop of argObj.properties) {
    const key = propName(prop);
    if ((key === "select" || key === "include") && ts.isPropertyAssignment(prop)) {
      const nested = toObjectLiteral(checker, prop.initializer);
      if (nested) walkSelectionMap(checker, nested, rootModel, hits);
    }
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan
// ─────────────────────────────────────────────────────────────────────────────

// Known-kind receivers in db.server.ts. If either fails to classify, the checker cannot see the
// client types (e.g. generated clients missing) and every verdict would be a silent false-clean,
// so the guard refuses to report instead of rubber-stamping.
const CLASSIFICATION_ANCHORS: Array<{ name: string; expected: ClientKind }> = [
  { name: "runOpsLegacyPrisma", expected: "cp" },
  { name: "runOpsNewPrismaClient", expected: "runops" },
];

function assertClassificationAnchors(program: ts.Program, checker: ts.TypeChecker): void {
  const anchorFile = path.join(WEBAPP_DIR, "app", "db.server.ts");
  const sf = program.getSourceFile(anchorFile);
  const problems: string[] = [];
  if (!sf) {
    problems.push(`${repoRel(anchorFile)} is not part of the program`);
  } else {
    for (const anchor of CLASSIFICATION_ANCHORS) {
      let ident: ts.Identifier | undefined;
      const find = (node: ts.Node): void => {
        if (ident) return;
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === anchor.name
        ) {
          ident = node.name;
          return;
        }
        ts.forEachChild(node, find);
      };
      find(sf);
      if (!ident) {
        problems.push(`anchor "${anchor.name}" not found in ${repoRel(anchorFile)}`);
        continue;
      }
      const receiverType = checker.getTypeAtLocation(ident);
      const delegateSym = receiverType.getProperty("taskRun");
      const got = delegateSym
        ? classifyType(checker, checker.getTypeOfSymbolAtLocation(delegateSym, ident))
        : "unresolved";
      if (got !== anchor.expected) {
        problems.push(`${anchor.name}.taskRun classified "${got}", expected "${anchor.expected}"`);
      }
    }
  }
  if (problems.length) {
    console.error(
      `[runops-guard] CLASSIFICATION ANCHORS FAILED — the guard cannot distinguish the ` +
        `control-plane and run-ops clients in this environment, so its verdicts would be ` +
        `meaningless:\n  ${problems.join("\n  ")}\n` +
        `Ensure the generated Prisma clients exist (pnpm run generate) and retry.`
    );
    process.exit(2);
  }
}

function scan(): ScanResult {
  const program = buildProgram();
  const checker = program.getTypeChecker();
  assertClassificationAnchors(program, checker);
  return scanProgram(program, checker, (fileName) => isInScope(repoRel(fileName)));
}

// Core scan, parameterized on the program + an in-scope predicate so the in-memory self-test
// fixtures (--selftest) exercise the exact same detector/annotation logic as the real sweep.
function scanProgram(
  program: ts.Program,
  checker: ts.TypeChecker,
  inScope: (fileName: string) => boolean
): ScanResult {
  const found = new Map<string, Violation>();
  const markers: Marker[] = [];
  const markerErrors: MarkerError[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!inScope(sf.fileName)) continue;
    const file = repoRel(sf.fileName);
    // This file's findings, each with the unit its marker would sit above. Keyed by the positions
    // of the finding's node and of the reported node, so two accesses on one line, or two queries
    // that share a selection constant (detector ii reports the constant's key), are two findings.
    const fileFound = new Map<string, { v: Violation; unit: ts.Node }>();
    const add = (v: Violation, node: ts.Node, at: ts.Node) => {
      fileFound.set(`${violationKey(v)}@${node.getStart(sf)}@${at.getStart(sf)}`, {
        v,
        unit: unitOf(node),
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const methodAccess = node.expression;
        const method = methodAccess.name.text;
        const kind = methodKind(method);
        const delegateAccess = methodAccess.expression;
        const delegateType = kind ? checker.getTypeAtLocation(delegateAccess) : undefined;
        const model = delegateType ? runGraphDelegateModel(delegateType) : undefined;

        // Detector (i): a call on a run-graph model delegate of either client, however reached.
        if (kind && delegateType && model) {
          const delegateName = lowerFirst(model);
          const clientKind = classifyType(checker, delegateType);
          if (clientKind === "cp" || clientKind === "runops") {
            const line = lineOf(
              sf,
              ts.isPropertyAccessExpression(delegateAccess) ? delegateAccess.name : delegateAccess
            );
            add(
              {
                file,
                line,
                model: capFirst(delegateName),
                delegate: delegateName,
                callKind: kind,
                detector: "i",
                snippet: lineText(sf, line),
              },
              node,
              ts.isPropertyAccessExpression(delegateAccess) ? delegateAccess.name : delegateAccess
            );
          }
        }

        if (kind && ts.isPropertyAccessExpression(delegateAccess)) {
          const delegateName = delegateAccess.name.text;
          // Detector (ii): cross-seam include/select traversal (any control-plane delegate).
          const rootModel = delegateToModel.get(delegateName);
          if (rootModel) {
            const hits = collectCrossSeamHits(checker, node.arguments[0], rootModel);
            if (hits.length) {
              const clientKind = classifyType(checker, checker.getTypeAtLocation(delegateAccess));
              if (clientKind === "cp") {
                for (const hit of hits) {
                  const line = lineOf(sf, hit.keyNode);
                  add(
                    {
                      file,
                      line,
                      model: hit.ownerModel,
                      delegate: hit.relation,
                      callKind: kind,
                      detector: "ii",
                      snippet: lineText(sf, line),
                    },
                    node,
                    hit.keyNode
                  );
                }
              }
            }
          }
        }
      }

      // Detector (iii): a run-ops read-through slot assigned a control-plane client.
      if (ts.isPropertyAssignment(node)) {
        const key = propName(node);
        if (
          key &&
          RUN_OPS_READTHROUGH_SLOTS.has(key) &&
          valueIsControlPlaneClient(node.initializer)
        ) {
          const line = lineOf(sf, node.name);
          add(
            {
              file,
              line,
              model: capFirst(key),
              delegate: key,
              callKind: "read",
              detector: "iii",
              snippet: lineText(sf, line),
            },
            node,
            node.name
          );
        }
      }

      // Detector (iv): raw SQL on a database client that names a run-graph table. The receiver
      // (a tx handle or replica is an Omit<> of the client) is classified by where the method is
      // declared, not by the receiver type's own symbol.
      const rawCallee = ts.isCallExpression(node)
        ? node.expression
        : ts.isTaggedTemplateExpression(node)
          ? node.tag
          : undefined;
      if (
        rawCallee &&
        ts.isPropertyAccessExpression(rawCallee) &&
        RAW_QUERY_METHODS.has(rawCallee.name.text)
      ) {
        const decls = checker.getSymbolAtLocation(rawCallee.name)?.declarations ?? [];
        if (decls.some((d) => declFileKind(d.getSourceFile().fileName))) {
          const sql: string[] = [];
          // The SQL is the first argument; later arguments are bound values.
          if (ts.isCallExpression(node)) {
            if (node.arguments[0]) collectSqlText(node.arguments[0], sql);
          } else collectSqlText((node as ts.TaggedTemplateExpression).template, sql);
          const text = sql.join(" ");
          const method = rawCallee.name.text;
          const line = lineOf(sf, rawCallee.name);
          for (const table of RUN_GRAPH_TABLES) {
            if (!text.includes(`"${table}"`)) continue;
            add(
              {
                file,
                line,
                model: table,
                delegate: method,
                callKind: method.startsWith("$query") ? "read" : "write",
                detector: "iv",
                snippet: lineText(sf, line),
              },
              node,
              rawCallee.name
            );
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);

    // Markers: the last well-formed marker among a unit's leading comments honours the unit's
    // findings; any other well-formed marker is off target.
    const comments = sf.text.includes(MARKER_TAG) ? markerComments(sf) : [];
    const wellFormed = new Map<number, RegExpExecArray>();
    for (const r of comments) {
      const text = sf.text.slice(r.pos, r.end);
      const m = MARKER_PATTERN.exec(text);
      if (m) wellFormed.set(r.pos, m);
      else markerErrors.push({ file, line: lineOfPos(sf, r.pos), kind: "malformed", text });
    }
    const byUnit = new Map<ts.Node, Violation[]>();
    for (const { v, unit } of fileFound.values())
      byUnit.set(unit, [...(byUnit.get(unit) ?? []), v]);
    const used = new Set<number>();
    for (const [unit, vs] of byUnit) {
      const own = (ts.getLeadingCommentRanges(sf.text, unit.getFullStart()) ?? []).filter((r) =>
        wellFormed.has(r.pos)
      );
      const marker = own[own.length - 1];
      if (!marker) {
        for (const v of vs) found.set(violationKey(v), v);
        continue;
      }
      used.add(marker.pos);
      const m = wellFormed.get(marker.pos)!;
      markers.push({
        file,
        line: lineOfPos(sf, marker.pos),
        owner: m[1],
        reason: m[2],
        findings: vs.map(findingLabel).sort(),
      });
    }
    for (const r of comments) {
      if (!wellFormed.has(r.pos) || used.has(r.pos)) continue;
      const text = sf.text.slice(r.pos, r.end);
      markerErrors.push({ file, line: lineOfPos(sf, r.pos), kind: "off target", text });
    }
  }

  const byFileLine = (a: { file: string; line: number }, b: { file: string; line: number }) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line;
  return {
    violations: sortViolations(Array.from(found.values())),
    markers: markers.sort(byFileLine),
    markerErrors: markerErrors.sort(byFileLine),
  };
}

function capFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function sortViolations(vs: Violation[]): Violation[] {
  return vs.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.detector !== b.detector) return a.detector < b.detector ? -1 : 1;
    if (a.model !== b.model) return a.model < b.model ? -1 : 1;
    if (a.delegate !== b.delegate) return a.delegate < b.delegate ? -1 : 1;
    return a.callKind < b.callKind ? -1 : a.callKind > b.callKind ? 1 : 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline IO
// ─────────────────────────────────────────────────────────────────────────────

type Baseline = {
  $comment: string;
  regenerate: string;
  runGraphSchemas: string[];
  runGraphModels: string[];
  runGraphTables: string[];
  crossSeamRelations: string[];
  totals: {
    violations: number;
    detectorI: number;
    detectorII: number;
    detectorIII: number;
    detectorIV: number;
    write: number;
    read: number;
    files: number;
    markers: number;
  };
  violations: Violation[];
  // Honoured markers. `--check` compares them with the scan by count per key; any drift fails.
  markers: Marker[];
};

function buildBaseline(result: ScanResult): Baseline {
  const { violations, markers } = result;
  return {
    $comment:
      "Track-1 run-ops legacy guard baseline. Generated by apps/webapp/scripts/runOpsLegacyGuard.ts. " +
      "`violations` lists unmarked findings: a code path that calls a run-graph model through the " +
      "control-plane or run-ops Prisma client, a transaction handle or a model accessor variable " +
      "(detector i), traverses a cross-seam relation (detector ii), puts a control-plane client in a " +
      "run-ops slot (detector iii), or names a run-graph table in raw SQL (detector iv). `markers` " +
      "lists each `runops-exception(<OWNER>): <reason>` marker and the findings it covers. " +
      "Do NOT edit by hand — regenerate instead.",
    regenerate: "pnpm --filter webapp run guard:runops-legacy",
    runGraphSchemas: RUN_GRAPH_SCHEMA_PATHS,
    runGraphModels: Array.from(RUN_GRAPH_MODELS).sort(),
    runGraphTables: RUN_GRAPH_TABLES,
    crossSeamRelations: crossSeamRelationList,
    totals: {
      violations: violations.length,
      detectorI: violations.filter((v) => v.detector === "i").length,
      detectorII: violations.filter((v) => v.detector === "ii").length,
      detectorIII: violations.filter((v) => v.detector === "iii").length,
      detectorIV: violations.filter((v) => v.detector === "iv").length,
      write: violations.filter((v) => v.callKind === "write").length,
      read: violations.filter((v) => v.callKind === "read").length,
      files: new Set(violations.map((v) => v.file)).size,
      markers: markers.length,
    },
    violations,
    markers,
  };
}

function writeBaseline(baseline: Baseline): void {
  // A string array that fits in 100 columns goes on one line, as CI's `oxfmt --check` prints it.
  const text = JSON.stringify(baseline, null, 2).replace(
    /^( *"\w+": )\[\n((?: *"[^"\n]*",?\n)+) *\](,?)$/gm,
    (whole, head: string, items: string, comma: string) => {
      const line = `${head}[${items.trim().split(/,\n */).join(", ")}]${comma}`;
      return line.length <= 100 ? line : whole;
    }
  );
  fs.writeFileSync(BASELINE_PATH, text + "\n", "utf8");
}

function readBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(
      `Baseline not found at ${repoRel(BASELINE_PATH)}. Run without --check to generate it first.`
    );
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-tests (anchors) — run scanProgram over in-memory fixtures that mimic the brand types, so the
// MECH-1/MECH-2 decision logic is exercised without building the full webapp program. The fixture
// delegate types are declared in virtual files whose paths trip declFileKind (cp vs runops).
// ─────────────────────────────────────────────────────────────────────────────

const VIRTUAL_CP_DTS = "/virtual/internal-packages/database/index.d.ts";
const VIRTUAL_RUNOPS_DTS = "/virtual/internal-packages/run-ops-database/index.d.ts";
// Outside both client paths, so an Omit<> type's own symbol classifies as neither client.
const VIRTUAL_UTILITY_DTS = "/virtual/lib/utility-types.d.ts";
const VIRTUAL_MODULE_MAP: Record<string, string> = {
  "@trigger.dev/database": VIRTUAL_CP_DTS,
  "@internal/run-ops-database": VIRTUAL_RUNOPS_DTS,
};

const VIRTUAL_RAW_METHODS = `$queryRaw(q?:any, ...v:any[]):any; $executeRaw(q?:any, ...v:any[]):any; $queryRawUnsafe(q?:any, ...v:any[]):any; $executeRawUnsafe(q?:any, ...v:any[]):any;`;

const VIRTUAL_CP_SOURCE = `
export interface TaskRunDelegate { create(a?:any):any; createMany(a?:any):any; update(a?:any):any; updateMany(a?:any):any; upsert(a?:any):any; delete(a?:any):any; deleteMany(a?:any):any; findFirst(a?:any):any; findMany(a?:any):any; count(a?:any):any; }
export interface TaskRunAttemptDelegate { create(a?:any):any; update(a?:any):any; }
export interface BatchTaskRunDelegate { findFirst(a?:any):any; update(a?:any):any; }
export interface WaitpointDelegate { findFirst(a?:any):any; }
export interface ProjectDelegate { findFirst(a?:any):any; findMany(a?:any):any; update(a?:any):any; }
export declare class PrismaClient { taskRun: TaskRunDelegate; taskRunAttempt: TaskRunAttemptDelegate; batchTaskRun: BatchTaskRunDelegate; waitpoint: WaitpointDelegate; project: ProjectDelegate; ${VIRTUAL_RAW_METHODS} $transaction<R>(fn: (tx: Omit<PrismaClient, "$transaction">) => R): R; }
export type PrismaReplicaClient = PrismaClient;
export declare namespace Prisma { function sql(s?:any, ...v:any[]):any; function raw(s?:any):any; function join(v?:any):any; }
`;

const VIRTUAL_RUNOPS_SOURCE = `
export interface TaskRunDelegate { create(a?:any):any; update(a?:any):any; updateMany(a?:any):any; findFirst(a?:any):any; findMany(a?:any):any; }
export interface WaitpointDelegate { findFirst(a?:any):any; }
export declare class RunOpsPrismaClient { taskRun: TaskRunDelegate; waitpoint: WaitpointDelegate; ${VIRTUAL_RAW_METHODS} $transaction<R>(fn: (tx: Omit<RunOpsPrismaClient, "$transaction">) => R): R; }
`;

const VIRTUAL_UTILITY_SOURCE = `
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Exclude<T, U> = T extends U ? never : T;
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
`;

type SelfTestExpect = {
  violations: number;
  honored: number;
  errors: number;
  models?: string[];
  findings?: string[];
};
// `path` is repository-relative; the default is apps/webapp/app/selftest/<name>.ts.
type SelfTestFixture = {
  name: string;
  code: string;
  expect: SelfTestExpect;
  path?: string;
  coveredRootsOnly?: boolean;
};

const SELF_TEST_FIXTURES: SelfTestFixture[] = [
  {
    // A retired tag (runops-legacy-ok, runops-routed-ok) is a plain comment: the access is reported.
    name: "legacyOkBarePrisma",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.taskRun.update({ where: {}, data: {} }); // runops-legacy-ok: bogus on control-plane
}`,
    expect: { violations: 1, honored: 0, errors: 0 },
  },
  {
    // A retired tag (runops-legacy-ok, runops-routed-ok) is a plain comment: the access is reported.
    name: "legacyOkLegacyHandle",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const runOpsLegacyPrisma: PrismaClient;
function f() {
  runOpsLegacyPrisma.taskRun.update({ where: {}, data: {} }); // runops-legacy-ok: legacy cuid write
}`,
    expect: { violations: 1, honored: 0, errors: 0 },
  },
  {
    // Tx-origin walk: a tx from $transaction(runOpsLegacyPrisma, …) is a legacy handle — the
    // annotated taskRun write is honored; the unmarked taskRunAttempt write is a violation.
    name: "txFromLegacyTransaction",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const runOpsLegacyPrisma: PrismaClient;
declare function $transaction<R>(client: PrismaClient, name: string, fn: (tx: PrismaClient) => R): R;
function f() {
  $transaction(runOpsLegacyPrisma, "x", (tx: PrismaClient) => {
    // runops-exception(legacy-teardown): run bump inside legacy tx
    tx.taskRun.update({ where: {}, data: {} });
    tx.taskRunAttempt.create({ data: {} });
    return 0;
  });
}`,
    expect: { violations: 1, honored: 1, errors: 0 },
  },
  {
    // A retired tag (runops-legacy-ok, runops-routed-ok) is a plain comment: the access is reported.
    name: "txFromRoutedRunInTransaction",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare function runInTransaction<R>(runId: string, fn: (tx: PrismaClient) => R): R;
function f() {
  runInTransaction("run_x", (tx: PrismaClient) => {
    tx.taskRun.update({ where: {}, data: {} }); // runops-legacy-ok: not actually legacy
    return 0;
  });
}`,
    expect: { violations: 1, honored: 0, errors: 0 },
  },
  {
    // Bare control-plane write with no annotation is a plain violation.
    name: "barePrismaViolation",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.taskRun.update({ where: {}, data: {} });
}`,
    expect: { violations: 1, honored: 0, errors: 0 },
  },
  {
    // A run write through the run-ops client is a violation: it must go through the run store.
    name: "runopsRebrand",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const runOpsLegacyPrismaClient: RunOpsPrismaClient;
function f() {
  runOpsLegacyPrismaClient.taskRun.update({ where: {}, data: {} });
}`,
    expect: { violations: 1, honored: 0, errors: 0 },
  },
  {
    // A retired tag (runops-legacy-ok, runops-routed-ok) is a plain comment: the access is reported.
    name: "routedOkInsideReadThrough",
    code: `import { PrismaReplicaClient } from "@trigger.dev/database";
declare function readThroughRun(input: any): any;
function f() {
  readThroughRun({
    runId: "x",
    readNew: (client: PrismaReplicaClient) =>
      client.taskRun.findFirst({ where: {} }), // runops-routed-ok: routed read new
    readLegacy: (replica: PrismaReplicaClient) =>
      replica.taskRun.findFirst({ where: {} }), // runops-routed-ok: routed read legacy
  });
}`,
    expect: { violations: 2, honored: 0, errors: 0 },
  },
  {
    // MECH-2 fallback negative: runops-routed-ok outside a read-through router is NOT honored.
    name: "routedOkNotRouted",
    code: `import { PrismaReplicaClient } from "@trigger.dev/database";
declare const replica: PrismaReplicaClient;
function f() {
  replica.taskRun.findFirst({ where: {} }); // runops-routed-ok: bogus not routed
}`,
    expect: { violations: 1, honored: 0, errors: 0 },
  },
  {
    // Detector (ii) still fires on a cross-seam include reached via the control-plane client.
    name: "crossSeamInclude",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.project.findFirst({ where: {}, include: { taskRuns: true } });
}`,
    expect: { violations: 1, honored: 0, errors: 0 },
  },
  {
    // No model-level exemption: an unmarked legacy-only delegate write on the legacy handle fails.
    name: "legacyOnlyExempt",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const runOpsLegacyPrisma: PrismaClient;
function f() {
  runOpsLegacyPrisma.taskRunAttempt.create({ data: {} });
}`,
    expect: { violations: 1, honored: 0, errors: 0 },
  },
  {
    // Detector (iii): a control-plane client ($replica) in a run-ops read-through slot is flagged;
    // newClient with a run-ops client and controlPlaneReplica with $replica are both fine.
    name: "readThroughSlotControlPlaneMisroute",
    code: `declare const $replica: any;
declare const runOpsNewReplica: any;
const cfg = { newClient: runOpsNewReplica, legacyReplica: $replica, controlPlaneReplica: $replica };`,
    expect: { violations: 1, honored: 0, errors: 0 },
  },
  {
    // Detector (iii) negative: correct run-ops clients in the slots — no violation.
    name: "readThroughSlotCorrect",
    code: `declare const runOpsNewReplica: any;
declare const runOpsLegacyReplica: any;
const cfg = { newClient: runOpsNewReplica, legacyReplica: runOpsLegacyReplica };`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  // Detector (i) on the run-ops client, a transaction handle and accessor variables.
  {
    name: "runOpsClientRunRead",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const client: RunOpsPrismaClient;
function f(id: string) {
  client.taskRun.findFirst({ where: { id } });
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "controlPlaneBatchWrite",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  prisma.batchTaskRun.update({ where: { id }, data: {} });
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["BatchTaskRun"] },
  },
  {
    name: "runEngineWaitpointRead",
    path: "internal-packages/run-engine/src/engine/systems/selftestWaitpointRead.ts",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  prisma.waitpoint.findFirst({ where: { id } });
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["Waitpoint"] },
  },
  {
    name: "runEngineCrossSeamInclude",
    path: "internal-packages/run-engine/src/engine/systems/selftestCrossSeamInclude.ts",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.project.findFirst({ where: {}, include: { taskRuns: true } });
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["Project"] },
  },
  {
    name: "txHandleWaitpointRead",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const runOps: RunOpsPrismaClient;
function f(id: string) {
  runOps.$transaction((tx) => tx.waitpoint.findFirst({ where: { id } }));
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["Waitpoint"] },
  },
  {
    name: "accessorVariable",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  const runs = prisma.taskRun;
  runs.findMany({ take: 1 });
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "destructuredAccessor",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  const { taskRun } = prisma;
  taskRun.findFirst({ where: { id } });
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  // Detector (iv): raw SQL naming a run-graph table.
  {
    name: "rawTaggedSchemaQualifiedSnapshot",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
declare const schema: any;
function f(id: string) {
  prisma.$queryRaw\`SELECT 1 FROM \${schema}."TaskRunExecutionSnapshot" WHERE id = \${id}\`;
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRunExecutionSnapshot"] },
  },
  {
    name: "rawUnsafeSnapshot",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const client: RunOpsPrismaClient;
function f(id: string) {
  client.$queryRawUnsafe('SELECT 1 FROM "TaskRunExecutionSnapshot" WHERE id = $1', id);
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRunExecutionSnapshot"] },
  },
  {
    name: "rawJoinTablePrismaSql",
    code: `import { PrismaClient, Prisma } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  prisma.$executeRaw(Prisma.sql\`DELETE FROM "_completedWaitpoints" WHERE "A" = \${id}\`);
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["_completedWaitpoints"] },
  },
  {
    name: "rawNestedPrismaRaw",
    code: `import { PrismaClient, Prisma } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.$queryRaw\`SELECT 1 FROM \${Prisma.raw('"Waitpoint"')}\`;
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["Waitpoint"] },
  },
  {
    name: "rawThroughTxHandle",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.$transaction((tx) => tx.$queryRaw\`SELECT 1 FROM "TaskRun"\`);
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "rawParenthesizedUnsafe",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const client: RunOpsPrismaClient;
function f() {
  client.$queryRawUnsafe(('SELECT 1 FROM "TaskRun"'));
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "rawAssertedPrismaSql",
    code: `import { PrismaClient, Prisma } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  prisma.$executeRaw(Prisma.sql\`DELETE FROM "_completedWaitpoints" WHERE "A" = \${id}\` as any);
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["_completedWaitpoints"] },
  },
  // Allowed uses: no finding.
  {
    name: "typeOnlyAccessorReference",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
type D = typeof prisma.taskRun;
declare const d: D;`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "storeWiring",
    code: `import { PrismaClient } from "@trigger.dev/database";
import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const prisma: PrismaClient;
declare const runOps: RunOpsPrismaClient;
declare class PostgresRunStore { constructor(o: { prisma: PrismaClient; runOps: RunOpsPrismaClient }); }
declare function wrapClient(c: RunOpsPrismaClient): RunOpsPrismaClient;
const store = new PostgresRunStore({ prisma, runOps });
const wrapped = wrapClient(runOps);`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  ...[
    ["testHelperRunWrite", "apps/webapp/test/helpers/selftestRuns.ts"],
    ["testFixturesRunWrite", "apps/webapp/test/fixtures/selftestRuns.ts"],
    [
      "runEngineTestsHelperRunWrite",
      "internal-packages/run-engine/src/engine/tests/helpers/selftestRuns.ts",
    ],
    ["testFileRunWrite", "apps/webapp/app/selftest/testFileRunWrite.test.ts"],
    ["seedScriptRunWrite", "apps/webapp/seed-selftest.ts"],
    ["populateScriptRunWrite", "apps/webapp/prisma/populate.ts"],
  ].map(([name, file]) => ({
    name,
    path: file,
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  prisma.taskRun.update({ where: { id }, data: {} });
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  })),
  {
    name: "tableNameInComment",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.$queryRawUnsafe(
    // was: SELECT 1 FROM "TaskRun"
    "SELECT 1"
  );
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "tableNameInLogMessage",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
declare const logger: { info(m: string, o?: any): void };
function f() {
  logger.info('read from "TaskRun"', { model: "TaskRun" });
  prisma.$queryRaw\`SELECT 1\`;
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "tableNameInLabel",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
const columns = [{ label: '"TaskRun" id', key: "id" }];
function f() {
  prisma.$queryRaw\`SELECT 1\`;
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "replicationTableSetting",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const runOps: RunOpsPrismaClient;
declare function startReplication(c: RunOpsPrismaClient, o: { table: string }): void;
startReplication(runOps, { table: "TaskRun" });`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "electricShapeTable",
    code: `declare const url: { searchParams: { set(k: string, v: string): void } };
url.searchParams.set("table", 'public."TaskRun"');`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "rawAdvisoryLock",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(key: string) {
  prisma.$transaction((tx) => tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext(\${key}))\`);
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "rawXactStatus",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const runOps: RunOpsPrismaClient;
function f(xid: string) {
  runOps.$queryRawUnsafe("SELECT pg_xact_status($1::xid8) AS status", xid);
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "rawUnsafeBoundValue",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const client: RunOpsPrismaClient;
function f() {
  client.$queryRawUnsafe('SELECT $1::text AS label', '"TaskRun"');
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "rawTaggedBoundValue",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.$queryRaw\`SELECT \${'"TaskRun"'}::text AS label\`;
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "rawJoinBoundValues",
    code: `import { PrismaClient, Prisma } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.$queryRaw\`SELECT 1 WHERE 'x' IN (\${Prisma.join(['"TaskRun"'])})\`;
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "rawTableWithRunGraphPrefix",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.$queryRaw\`SELECT 1 FROM "TaskRunTemplate"\`;
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "taskRunVariableNotAccessor",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  const taskRun = prisma.project;
  taskRun.update({});
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "runStoreRunOpsRead",
    path: "internal-packages/run-store/src/selftestRead.ts",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const client: RunOpsPrismaClient;
function f(id: string) {
  client.taskRun.findFirst({ where: { id } });
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "runStoreRawSnapshot",
    path: "internal-packages/run-store/src/selftestRaw.ts",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const client: RunOpsPrismaClient;
function f(id: string) {
  client.$queryRawUnsafe('SELECT 1 FROM "TaskRunExecutionSnapshot" WHERE id = $1', id);
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "delegateParameter",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function listRuns(runs: PrismaClient["taskRun"]) {
  return runs.findMany({ take: 1 });
}
listRuns(prisma.taskRun);`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "delegateClassField",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
class RunReader {
  constructor(private readonly runs: RunOpsPrismaClient["taskRun"]) {}
  read(id: string) {
    return this.runs.findFirst({ where: { id } });
  }
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "unionReceiverRunRead",
    code: `import { PrismaClient } from "@trigger.dev/database";
import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const legacy: PrismaClient;
declare const runOps: RunOpsPrismaClient | undefined;
function f(id: string) {
  (runOps ?? legacy).taskRun.findFirst({ where: { id } });
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "lookAlikeDelegateParameter",
    code: `interface TaskRunDelegate { findMany(a?: any): any; }
function listRuns(runs: TaskRunDelegate) {
  return runs.findMany({ take: 1 });
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    name: "rawExecuteUnsafe",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  prisma.$executeRawUnsafe('DELETE FROM "Waitpoint" WHERE id = $1', id);
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["Waitpoint"] },
  },
  {
    name: "rawConcatenatedLiterals",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const client: RunOpsPrismaClient;
function f(id: string) {
  client.$queryRawUnsafe('SELECT 1 FROM "TaskRun" ' + "WHERE id = $1", id);
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "testcontainersRunWrite",
    path: "internal-packages/testcontainers/src/selftestRuns.ts",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  prisma.taskRun.update({ where: { id }, data: {} });
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  // In scope: `test` inside a route name, and a `fixtures` directory outside a test directory.
  ...[
    [
      "testRouteDirectoryName",
      "apps/webapp/app/routes/_app.env.$envParam.test.tasks.$taskParam/route.ts",
    ],
    ["testRouteFileName", "apps/webapp/app/routes/resources.env.$envParam.test.payload.ts"],
    [
      "dashboardAgentFixtures",
      "apps/webapp/app/components/dashboard-agent/demo/fixtures/selftestRuns.ts",
    ],
    ["coreBuildDirRunRead", "packages/core/src/v3/build/selftestRunRead.ts"],
  ].map(([name, file]) => ({
    name,
    path: file,
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  prisma.taskRun.findFirst({ where: { id } });
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  })),
  // Scoped by the real COVERED_ROOTS: a run read under each covered root is reported, outside none.
  ...[
    ["rootWebapp", "apps/webapp/app/selftestRootRunRead.ts", 1],
    ["rootRunEngineSrc", "internal-packages/run-engine/src/engine/selftestRootRunRead.ts", 1],
    ["rootRunEngineHarness", "internal-packages/run-engine/harness/selftestRootRunRead.ts", 1],
    ["rootScheduleEngine", "internal-packages/schedule-engine/src/selftestRootRunRead.ts", 1],
    ["rootWebhookEngine", "internal-packages/webhook-engine/src/selftestRootRunRead.ts", 1],
    ["rootRbac", "internal-packages/rbac/src/selftestRootRunRead.ts", 1],
    ["rootSso", "internal-packages/sso/src/selftestRootRunRead.ts", 1],
    ["rootLlmModelCatalog", "internal-packages/llm-model-catalog/src/selftestRootRunRead.ts", 1],
    ["rootCoreBuildDir", "packages/core/src/v3/build/selftestRootRunRead.ts", 1],
    ["rootScripts", "scripts/selftest-root-run-read.mts", 1],
    ["rootOutsideSupervisor", "apps/supervisor/src/selftestRootRunRead.ts", 0],
  ].map(([name, file, n]) => ({
    name: name as string,
    path: file as string,
    coveredRootsOnly: true,
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f(id: string) {
  prisma.taskRun.findFirst({ where: { id } });
}`,
    expect: n
      ? { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] }
      : { violations: 0, honored: 0, errors: 0 },
  })),
  // Markers: each honours the findings of its own unit, for any detector, on either client.
  {
    name: "markerControlPlaneCall",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  // runops-exception(legacy-teardown): self-test marker on a control-plane call
  prisma.taskRun.update({ where: {}, data: {} });
}`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    name: "markerRunOpsClient",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const runOpsLegacyPrismaClient: RunOpsPrismaClient;
function f() {
  // runops-exception(legacy-teardown): self-test marker on a run-ops client call
  runOpsLegacyPrismaClient.taskRun.update({ where: {}, data: {} });
}`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    name: "markerTxHandleArrowBody",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const runOps: RunOpsPrismaClient;
function f(id: string) {
  runOps.$transaction((tx) =>
    // runops-exception(legacy-teardown): self-test marker on an arrow function body
    tx.waitpoint.findFirst({ where: { id } })
  );
}`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    name: "markerAccessorVariable",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  const runs = prisma.taskRun;
  // runops-exception(legacy-teardown): self-test marker on an accessor variable
  runs.findMany({ take: 1 });
}`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    name: "markerDelegateParameter",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function listRuns(runs: PrismaClient["taskRun"]) {
  // runops-exception(legacy-teardown): self-test marker on a delegate parameter
  return runs.findMany({ take: 1 });
}
listRuns(prisma.taskRun);`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    name: "markerDelegateClassField",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
class RunReader {
  constructor(private readonly runs: RunOpsPrismaClient["taskRun"]) {}
  read(id: string) {
    // runops-exception(legacy-teardown): self-test marker on a delegate class field
    return this.runs.findFirst({ where: { id } });
  }
}`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    name: "markerCrossSeamInclude",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  // runops-exception(legacy-teardown): self-test marker on a cross-seam include
  prisma.project.findFirst({ where: {}, include: { taskRuns: true } });
}`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    name: "markerControlPlaneSlot",
    code: `declare const $replica: any;
declare const runOpsNewReplica: any;
// runops-exception(legacy-teardown): self-test marker on a control-plane client in a run-ops slot
const cfg = { newClient: runOpsNewReplica, legacyReplica: $replica, controlPlaneReplica: $replica };`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    name: "markerRawTwoTables",
    code: `import { PrismaClient, Prisma } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  // runops-exception(legacy-teardown): self-test marker on a raw query naming two tables
  prisma.$queryRaw(Prisma.sql\`SELECT s."id" FROM "TaskRunExecutionSnapshot" s LEFT JOIN "_completedWaitpoints" cw ON cw."A" = s."id"\`);
}`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    name: "markerOneStatementOnly",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  // runops-exception(legacy-teardown): self-test marker on the first of two writes
  prisma.taskRun.update({ where: {}, data: {} });
  prisma.taskRun.update({ where: {}, data: {} });
}`,
    expect: { violations: 1, honored: 1, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "markerOffTarget",
    code: `import { PrismaClient } from "@trigger.dev/database";
import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const prisma: PrismaClient;
declare const runOps: RunOpsPrismaClient;
declare class PostgresRunStore { constructor(o: { prisma: PrismaClient; runOps: RunOpsPrismaClient }); }
// runops-exception(legacy-teardown): self-test marker above a statement with no finding
const store = new PostgresRunStore({ prisma, runOps });`,
    expect: { violations: 0, honored: 0, errors: 1 },
  },
  {
    name: "markerInsideArguments",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const client: RunOpsPrismaClient;
function f(id: string) {
  client.taskRun.findFirst({
    // runops-exception(legacy-teardown): self-test marker inside the call's arguments
    where: { id },
  });
}`,
    expect: { violations: 1, honored: 0, errors: 1, models: ["TaskRun"] },
  },
  {
    name: "markerMalformed",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  // runops-exception: self-test marker with no owner
  prisma.taskRun.update({ where: {}, data: {} });
}`,
    expect: { violations: 1, honored: 0, errors: 1, models: ["TaskRun"] },
  },
  {
    name: "markerTextInTemplate",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
const text = \`
// runops-exception(legacy-teardown): text in a template literal, not a comment
\`;
function f() {
  prisma.taskRun.update({ where: {}, data: {} });
}`,
    expect: { violations: 1, honored: 0, errors: 0, models: ["TaskRun"] },
  },
  {
    name: "markerTwoCallsOneLine",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  // runops-exception(legacy-teardown): self-test marker on two calls on one line
  [prisma.taskRun.update({ where: {}, data: {} }), prisma.taskRun.deleteMany({ where: {} })];
}`,
    expect: {
      violations: 0,
      honored: 1,
      errors: 0,
      findings: ["i/write TaskRun.taskRun", "i/write TaskRun.taskRun"],
    },
  },
  {
    name: "markerSharedSelectionFirstUnmarked",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
const selection = { taskRuns: true };
function f() {
  prisma.project.findMany({ include: selection });
  // runops-exception(legacy-teardown): self-test marker on the second of two queries sharing a selection
  prisma.project.findMany({ include: selection });
}`,
    expect: { violations: 1, honored: 1, errors: 0, models: ["Project"] },
  },
  {
    name: "markerSharedSelectionBothMarked",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
const selection = { taskRuns: true };
function f() {
  // runops-exception(legacy-teardown): self-test marker on the first of two queries sharing a selection
  prisma.project.findMany({ include: selection });
  // runops-exception(legacy-teardown): self-test marker on the second of two queries sharing a selection
  prisma.project.findMany({ include: selection });
}`,
    expect: { violations: 0, honored: 2, errors: 0 },
  },
];

// The `--check` comparison of recorded and found markers, on made-up lists.
const cmpMarker = (line: number, findings = ["i/write TaskRun.taskRun"]): Marker => ({
  file: "apps/webapp/app/selftest/compareMarkers.ts",
  line,
  owner: "legacy-teardown",
  reason: "self-test marker",
  findings,
});
const MARKER_COMPARISON_CASES: Array<{
  name: string;
  recorded: Marker[];
  found: Marker[];
  expect: { stale: number; unrecorded: number };
}> = [
  {
    name: "compareStale",
    recorded: [cmpMarker(5)],
    found: [],
    expect: { stale: 1, unrecorded: 0 },
  },
  {
    name: "compareUnrecorded",
    recorded: [],
    found: [cmpMarker(5)],
    expect: { stale: 0, unrecorded: 1 },
  },
  {
    name: "compareStaleByCount",
    recorded: [cmpMarker(5), cmpMarker(9)],
    found: [cmpMarker(5)],
    expect: { stale: 1, unrecorded: 0 },
  },
  {
    name: "compareLineMoved",
    recorded: [cmpMarker(5)],
    found: [cmpMarker(7)],
    expect: { stale: 0, unrecorded: 0 },
  },
  {
    name: "compareFindingsChanged",
    recorded: [cmpMarker(5)],
    found: [cmpMarker(5, ["i/write TaskRun.taskRun", "i/write TaskRun.taskRun"])],
    expect: { stale: 1, unrecorded: 1 },
  },
];

function buildVirtualProgram(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
    types: [],
    noEmit: true,
    strict: false,
    skipLibCheck: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = files[fileName];
      return text !== undefined
        ? ts.createSourceFile(fileName, text, languageVersion, /* setParentNodes */ true)
        : undefined;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/virtual",
    getDirectories: () => [],
    fileExists: (fileName) => fileName in files,
    readFile: (fileName) => files[fileName],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name): ts.ResolvedModuleFull | undefined => {
        const resolvedFileName = VIRTUAL_MODULE_MAP[name];
        return resolvedFileName ? { resolvedFileName, extension: ts.Extension.Dts } : undefined;
      }),
  };
  return ts.createProgram({ rootNames: Object.keys(files), options, host });
}

function runSelfTests(): void {
  const files: Record<string, string> = {
    [VIRTUAL_CP_DTS]: VIRTUAL_CP_SOURCE,
    [VIRTUAL_RUNOPS_DTS]: VIRTUAL_RUNOPS_SOURCE,
    [VIRTUAL_UTILITY_DTS]: VIRTUAL_UTILITY_SOURCE,
  };
  const fixturePath = (fx: SelfTestFixture) =>
    `/virtual/${fx.path ?? `apps/webapp/app/selftest/${fx.name}.ts`}`;
  for (const fx of SELF_TEST_FIXTURES) files[fixturePath(fx)] = fx.code;

  const program = buildVirtualProgram(files);
  const checker = program.getTypeChecker();
  // The real scope rule, with one covered root holding every path: the exclusions decide.
  // A coveredRootsOnly case is scoped by the real COVERED_ROOTS instead.
  const rootScoped = new Set(
    SELF_TEST_FIXTURES.filter((fx) => fx.coveredRootsOnly).map(fixturePath)
  );
  const result = scanProgram(
    program,
    checker,
    (fileName) =>
      fileName.startsWith("/virtual/") &&
      isInScope(fileName.slice("/virtual/".length), rootScoped.has(fileName) ? COVERED_ROOTS : [""])
  );

  const failures: string[] = [];
  for (const fx of SELF_TEST_FIXTURES) {
    const file = repoRel(fixturePath(fx));
    const found = result.violations.filter((v) => v.file === file);
    const honored = result.markers.filter((m) => m.file === file).length;
    const errors = result.markerErrors.filter((e) => e.file === file).length;
    const got = {
      violations: found.length,
      honored,
      errors,
      models: found.map((v) => v.model).sort(),
      findings: result.markers.filter((m) => m.file === file).flatMap((m) => m.findings),
    };
    if (
      got.violations !== fx.expect.violations ||
      got.honored !== fx.expect.honored ||
      got.errors !== fx.expect.errors ||
      (fx.expect.models && got.models.join() !== fx.expect.models.join()) ||
      (fx.expect.findings && got.findings.join() !== fx.expect.findings.join())
    ) {
      failures.push(
        `${fx.name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(fx.expect)}`
      );
    }
  }

  for (const c of MARKER_COMPARISON_CASES) {
    const r = compareMarkers(c.recorded, c.found);
    const got = { stale: r.stale.length, unrecorded: r.unrecorded.length };
    if (got.stale !== c.expect.stale || got.unrecorded !== c.expect.unrecorded) {
      failures.push(`${c.name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expect)}`);
    }
  }

  if (failures.length) {
    console.error(
      `[runops-guard] SELF-TEST FAILURES (guard logic is broken):\n  ${failures.join("\n  ")}`
    );
    process.exit(3);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  // The mechanism self-tests run first (both modes), and in isolation under --selftest, so CI
  // exercises the guard's own logic on every invocation without building the full webapp program.
  runSelfTests();
  if (args.includes("--selftest")) {
    console.error(`[runops-guard] self-tests passed.`);
    return;
  }

  const check = args.includes("--check");

  for (const dir of [CP_GENERATED_DIR, ...RUN_GRAPH_GENERATED_DIRS]) {
    if (!fs.existsSync(path.join(dir, "index.d.ts"))) {
      console.error(
        `[runops-guard] generated Prisma client missing at ${repoRel(dir)} — run: pnpm run generate`
      );
      process.exit(2);
    }
  }
  for (const root of COVERED_ROOTS) {
    if (!fs.statSync(path.join(REPO_ROOT, root), { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`[runops-guard] covered root missing: ${root}`);
      process.exit(2);
    }
  }

  console.error(`[runops-guard] repo root: ${REPO_ROOT}`);
  console.error(
    `[runops-guard] run-graph delegates: ${Array.from(RUN_GRAPH_DELEGATES).join(", ")}`
  );
  console.error(`[runops-guard] cross-seam relations: ${crossSeamRelationList.length}`);
  console.error(`[runops-guard] building program from ${repoRel(TSCONFIG_PATH)} ...`);

  const result = scan();
  const { violations, markers, markerErrors } = result;
  const baseline = buildBaseline(result);

  console.error(
    `[runops-guard] found ${violations.length} violations ` +
      `(detector-i: ${baseline.totals.detectorI}, detector-ii: ${baseline.totals.detectorII}, detector-iii: ${baseline.totals.detectorIII}, detector-iv: ${baseline.totals.detectorIV}; ` +
      `write: ${baseline.totals.write}, read: ${baseline.totals.read}; files: ${baseline.totals.files}); ` +
      `markers: ${markers.length}`
  );

  const form =
    "a marker is `// runops-exception(<OWNER>): <reason>`, directly above the statement or arrow " +
    "function body that holds the access";
  // A malformed or off-target marker can never be baselined, so it fails both modes.
  const reportMarkerErrors = () => {
    if (!markerErrors.length) return;
    console.error(`\n[runops-guard] ${markerErrors.length} marker error(s):\n`);
    for (const e of markerErrors) {
      console.error(`  ${e.kind}: ${e.file}:${e.line}  ${e.text}\n    ${form}`);
    }
  };
  const describe = (m: Marker) =>
    `${m.file}:${m.line}  runops-exception(${m.owner}): ${m.reason}  [${m.findings.join(", ")}]`;

  if (!check) {
    writeBaseline(baseline);
    console.error(`[runops-guard] baseline written to ${repoRel(BASELINE_PATH)}`);
    for (const v of violations) {
      console.log(
        `${v.file}:${v.line}  [${v.detector}/${v.callKind}]  ${v.model}.${v.delegate}  ${v.snippet}`
      );
    }
    reportMarkerErrors();
    if (markerErrors.length) process.exit(1);
    return;
  }

  const parsed = readBaseline();
  const baselineKeys = new Set((parsed.violations ?? []).map(violationKey));
  const currentKeys = new Set(violations.map(violationKey));
  const added = violations.filter((v) => !baselineKeys.has(violationKey(v)));
  const removed = Array.from(baselineKeys).filter((k) => !currentKeys.has(k));

  const { stale, unrecorded } = compareMarkers(parsed.markers ?? [], markers);

  if (removed.length) {
    console.error(
      `[runops-guard] ${removed.length} baseline entries no longer present (progress!). ` +
        `Regenerate the baseline to lock in the wins.`
    );
  }

  let failed = false;

  if (added.length) {
    console.error(`\n[runops-guard] ${added.length} NEW violation(s) not in the baseline:\n`);
    for (const v of added) {
      console.error(
        `  ${v.file}:${v.line}  [${v.detector}/${v.callKind}]  ${v.model}.${v.delegate}\n    ${v.snippet}`
      );
    }
    console.error(
      `\nReach run-graph models through the run store, or mark an allowed exception with ` +
        `\`// runops-exception(<OWNER>): <reason>\` directly above the statement that holds it, ` +
        `and regenerate the baseline: pnpm --filter webapp run guard:runops-legacy`
    );
    failed = true;
  }

  if (stale.length) {
    console.error(`\n[runops-guard] ${stale.length} stale marker(s):\n`);
    for (const m of stale) console.error(`  stale: ${describe(m)}`);
    console.error(
      `\nA stale marker's access has gone or is no longer scanned: remove the marker with its ` +
        `access and regenerate the baseline.`
    );
    failed = true;
  }

  if (unrecorded.length) {
    console.error(`\n[runops-guard] ${unrecorded.length} unrecorded marker(s):\n`);
    for (const m of unrecorded) console.error(`  unrecorded: ${describe(m)}`);
    console.error(
      `\nEvery marker must be recorded. Regenerate the baseline: ` +
        `pnpm --filter webapp run guard:runops-legacy`
    );
    failed = true;
  }

  if (markerErrors.length) {
    reportMarkerErrors();
    failed = true;
  }

  if (failed) process.exit(1);

  console.error(`[runops-guard] OK — no new violations beyond the baseline.`);
}

main();
