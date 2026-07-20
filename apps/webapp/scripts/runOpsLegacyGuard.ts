/**
 * Track-1 run-ops legacy guard (type-aware inventory) — SOURCE OF TRUTH for the three-DB-split
 * "Track 1" sweep. Builds a `ts.Program` over the webapp tsconfig and uses the TypeChecker to
 * resolve receiver types, catching aliased control-plane clients that grep/oxlint cannot.
 *
 *   Detector (i)  — a call to one of the 16 run-graph delegates whose receiver resolves BY TYPE to a
 *                   control-plane Prisma client (@trigger.dev/database), not the NEW run-ops client.
 *   Detector (ii) — an include/select of a relation crossing the run-graph <-> control-plane seam
 *                   (relation set derived by parsing both schema.prisma files).
 *
 * Modes: default regenerates the baseline; `--check` fails (exit 1) on any violation not baselined.
 *   pnpm --filter webapp run guard:runops-legacy            # regenerate baseline
 *   pnpm --filter webapp run guard:runops-legacy -- --check # CI gate
 */
import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error("Could not locate repo root (pnpm-workspace.yaml not found)");
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(process.cwd());
const WEBAPP_DIR = path.join(REPO_ROOT, "apps", "webapp");
const TSCONFIG_PATH = path.join(WEBAPP_DIR, "tsconfig.check.json");
const SCAN_ROOT = path.join(WEBAPP_DIR, "app");
const CP_SCHEMA = path.join(REPO_ROOT, "internal-packages", "database", "prisma", "schema.prisma");
const RUNOPS_SCHEMA = path.join(
  REPO_ROOT,
  "internal-packages",
  "run-ops-database",
  "prisma",
  "schema.prisma"
);
const BASELINE_PATH = path.join(WEBAPP_DIR, "app", "v3", "runOpsMigration", "track1-baseline.json");

const CP_PACKAGE_DIR = path.dirname(path.dirname(CP_SCHEMA));
const RUNOPS_PACKAGE_DIR = path.dirname(path.dirname(RUNOPS_SCHEMA));

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
const RUNOPS_GENERATED_DIR = generatedClientDir(RUNOPS_SCHEMA);

function realpathIfExists(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Classification roots, realpath'd to match the checker's realpath'd file names.
const RUNOPS_DECL_DIRS = [RUNOPS_GENERATED_DIR, RUNOPS_PACKAGE_DIR].map(realpathIfExists);
const CP_DECL_DIRS = [CP_GENERATED_DIR, CP_PACKAGE_DIR].map(realpathIfExists);

// Both client packages are force-resolved to SOURCE (src/ + generated client) when building the
// program, so classification never depends on a built/fresh `dist/` in the running environment.
const FORCED_TYPE_RESOLUTIONS = new Map<string, string>([
  ["@trigger.dev/database", path.join(CP_PACKAGE_DIR, "src", "index.ts")],
  ["@internal/run-ops-database", path.join(RUNOPS_PACKAGE_DIR, "src", "index.ts")],
]);

// Files excluded from the sweep. V1-only files come from .claude/rules/legacy-v3-code.md.
const V1_FILES = new Set(
  [
    "app/v3/legacyRunEngineWorker.server.ts",
    "app/v3/services/triggerTaskV1.server.ts",
    "app/v3/services/cancelTaskRunV1.server.ts",
    "app/v3/authenticatedSocketConnection.server.ts",
    "app/v3/sharedSocketConnection.ts",
  ].map((p) => path.join(WEBAPP_DIR, p))
);
const V1_DIRS = [path.join(WEBAPP_DIR, "app", "v3", "marqs") + path.sep];
// run-store lives outside the webapp, but exclude defensively in case it is ever program-visible.
const EXCLUDED_DIR_FRAGMENTS = [
  path.sep + "run-store" + path.sep,
  path.sep + "generated" + path.sep,
  path.sep + "dist" + path.sep,
  path.sep + "build" + path.sep,
  path.sep + "node_modules" + path.sep,
];

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

type SchemaModel = { name: string; fields: Array<{ name: string; baseType: string }> };

function parseSchemaModels(file: string): Map<string, SchemaModel> {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const models = new Map<string, SchemaModel>();
  let current: SchemaModel | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const modelStart = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
    if (modelStart) {
      current = { name: modelStart[1], fields: [] };
      models.set(current.name, current);
      continue;
    }
    if (!current) continue;
    if (line === "}") {
      current = null;
      continue;
    }
    if (!line || line.startsWith("//") || line.startsWith("@@") || line.startsWith("/")) continue;

    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*(?:\[\])?\??)/.exec(
      line
    );
    if (!fieldMatch) continue;
    const fieldName = fieldMatch[1];
    const baseType = fieldMatch[2].replace(/[?[\]]/g, "");
    current.fields.push({ name: fieldName, baseType });
  }
  return models;
}

function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

const runOpsModels = parseSchemaModels(RUNOPS_SCHEMA);
const RUN_GRAPH_MODELS = new Set(runOpsModels.keys()); // the 16 run-graph models
const RUN_GRAPH_DELEGATES = new Set(Array.from(RUN_GRAPH_MODELS, lowerFirst));

const cpModels = parseSchemaModels(CP_SCHEMA);
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

// Run-graph models Run Engine 2.0 never touches (zero refs in internal-packages/run-engine/src),
// so NEW runs never have rows in them: provably legacy-resident, safe to reach via the legacy
// handle. Every other run-graph model is dual-residency and must go through runStore.
const LEGACY_ONLY_DELEGATES = new Set([
  "taskRunAttempt",
  "checkpoint",
  "checkpointRestoreEvent",
  "taskRunDependency",
]);
const LEGACY_HANDLE_NAMES = new Set(["runOpsLegacyPrisma", "runOpsLegacyReplica"]);

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

// MECH-1/MECH-2 site-level annotations (track1-completion-plan.md, PLAN §T1.1). `runops-legacy-ok`
// suppresses a detector-(i) write only on a legacy handle; `runops-routed-ok` suppresses a read only
// inside a read-through router.
const LEGACY_OK_TAG = "runops-legacy-ok";
const ROUTED_OK_TAG = "runops-routed-ok";

// Tx helpers whose FIRST argument is the client the callback's `tx` binds to: `$transaction(client,
// name, cb)` and any `runInTransaction(handle, cb)`. The run-store's `runInTransaction(runId, cb)`
// takes a runId first (never a handle), so a routed tx is correctly NOT treated as legacy.
const TX_ORIGIN_FNS = new Set(["$transaction", "runInTransaction"]);
// Read-through routers that fan out new→legacy by id-shape; a delegate call inside one is routed.
const READ_THROUGH_FNS = new Set(["readThroughRun", "resolveWaitpointThroughReadThrough"]);

/** Name of the function being called, whether `fn(...)` or `receiver.fn(...)`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

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
  return ts.createProgram({ rootNames: parsed.fileNames, options, host: compilerHost });
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

/** True if `node` resolves (through parens/as/satisfies/non-null and simple const aliases) to
 *  the runOpsLegacyPrisma / runOpsLegacyReplica handle. Double-gated with LEGACY_ONLY_DELEGATES
 *  at the call site, so a loose name match only ever exempts the provably-legacy models. */
function receiverIsLegacyHandle(
  checker: ts.TypeChecker,
  node: ts.Expression,
  seen = new Set<ts.Node>()
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  let e: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  if (!ts.isIdentifier(e)) return false;
  if (LEGACY_HANDLE_NAMES.has(e.text)) return true;
  const sym = checker.getSymbolAtLocation(e);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    return receiverIsLegacyHandle(checker, decl.initializer, seen);
  }
  // Tx-origin walk: a `tx` parameter bound to the callback of `$transaction(<handle>, …, cb)` /
  // `runInTransaction(<handle>, cb)` inherits the residency of that call's FIRST argument, so it is
  // legacy iff that first argument is a legacy handle.
  if (decl && ts.isParameter(decl)) {
    return txParamOriginIsLegacy(checker, decl, seen);
  }
  return false;
}

/** A `tx`-style parameter is legacy iff it is the callback param of a TX_ORIGIN_FNS call whose
 *  first argument resolves (via receiverIsLegacyHandle) to a legacy handle. */
function txParamOriginIsLegacy(
  checker: ts.TypeChecker,
  param: ts.ParameterDeclaration,
  seen: Set<ts.Node>
): boolean {
  const fn = param.parent;
  if (!ts.isFunctionLike(fn)) return false;
  // The callback may be wrapped in parens before it reaches the call's argument list.
  let container: ts.Node = fn;
  while (container.parent && ts.isParenthesizedExpression(container.parent)) {
    container = container.parent;
  }
  const call = container.parent;
  if (!call || !ts.isCallExpression(call)) return false;
  if (!call.arguments.some((a) => a === container)) return false;
  const name = calleeName(call);
  if (!name || !TX_ORIGIN_FNS.has(name)) return false;
  const firstArg = call.arguments[0];
  return firstArg ? receiverIsLegacyHandle(checker, firstArg, seen) : false;
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

/** Unwrap parens / `as` / `satisfies` / non-null to the inner expression. */
function unwrapExpr(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Full (untrimmed) source text of a 1-based line, including any trailing newline. */
function rawLineText(sf: ts.SourceFile, line1: number): string {
  const starts = sf.getLineStarts();
  const idx = line1 - 1;
  const start = starts[idx];
  const end = idx + 1 < starts.length ? starts[idx + 1] : sf.text.length;
  return sf.text.slice(start, end);
}

/** The trimmed `<reason>` for a `// <tag>: <reason>` annotation attached to `node`'s enclosing
 *  statement — a leading comment above it, or any comment within the statement's line span. Node-
 *  relative (not a fixed line) so it survives formatter reflow, which moves lines but keeps a
 *  comment attached to its statement. */
function annotationReasonForNode(
  sf: ts.SourceFile,
  node: ts.Node,
  tag: string
): string | undefined {
  const re = new RegExp("//\\s*" + tag + ":\\s*(\\S.*?)\\s*$", "m");
  let stmt: ts.Node = node;
  while (
    stmt.parent &&
    !ts.isSourceFile(stmt.parent) &&
    !ts.isBlock(stmt.parent) &&
    !ts.isModuleBlock(stmt.parent)
  ) {
    stmt = stmt.parent;
  }
  const texts: string[] = [];
  for (const r of ts.getLeadingCommentRanges(sf.text, stmt.getFullStart()) ?? []) {
    texts.push(sf.text.slice(r.pos, r.end));
  }
  const startLine = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
  const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  for (let l = startLine; l <= endLine; l++) texts.push(rawLineText(sf, l));
  for (const t of texts) {
    const m = re.exec(t);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** True if the delegate call is a residency-routed read: lexically inside a READ_THROUGH_FNS call,
 *  or its receiver is a parameter of a closure that is (transitively) inside such a call. */
function isInsideReadThroughContext(
  checker: ts.TypeChecker,
  callNode: ts.Node,
  receiverExpr: ts.Expression
): boolean {
  for (let n: ts.Node | undefined = callNode; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && READ_THROUGH_FNS.has(name)) return true;
    }
  }
  const e = unwrapExpr(receiverExpr);
  if (ts.isIdentifier(e)) {
    const sym = checker.getSymbolAtLocation(e);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (decl && ts.isParameter(decl)) {
      for (let n: ts.Node | undefined = decl.parent; n; n = n.parent) {
        if (ts.isCallExpression(n)) {
          const name = calleeName(n);
          if (name && READ_THROUGH_FNS.has(name)) return true;
        }
      }
    }
  }
  return false;
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
  detector: "i" | "ii" | "iii";
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

// A honored MECH-1 `runops-legacy-ok` site. Recorded to the baseline's companion block and
// re-verified each run so a stale/moved annotation fails --check.
type LegacyAnnotation = { file: string; line: number; reason: string; receiver: string };
// A rejected annotation (e.g. `runops-legacy-ok` on a non-legacy receiver). Never baselined; always
// fails --check.
type AnnotationError = { file: string; line: number; receiver: string; message: string };

type ScanResult = {
  violations: Violation[];
  legacyAnnotations: LegacyAnnotation[];
  annotationErrors: AnnotationError[];
};

function annotationKey(a: LegacyAnnotation): string {
  // Line-insensitive: formatter reflow moves lines but not the (file, receiver, reason) identity,
  // so a pure re-format must not read as annotation drift. `line` stays on the record for humans.
  return [a.file, a.receiver, a.reason].join("::");
}

function repoRel(fileName: string): string {
  return path.relative(REPO_ROOT, fileName).split(path.sep).join("/");
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function lineText(sf: ts.SourceFile, line1: number): string {
  const starts = sf.getLineStarts();
  const idx = line1 - 1;
  const start = starts[idx];
  const end = idx + 1 < starts.length ? starts[idx + 1] : sf.text.length;
  return sf.text.slice(start, end).trim().slice(0, 200);
}

function isInScope(fileName: string): boolean {
  const f = path.resolve(fileName);
  if (!f.startsWith(SCAN_ROOT + path.sep)) return false;
  if (/\.test\.tsx?$/.test(f) || /\.test\.mts$/.test(f)) return false;
  if (V1_FILES.has(f)) return false;
  if (V1_DIRS.some((d) => f.startsWith(d))) return false;
  if (EXCLUDED_DIR_FRAGMENTS.some((frag) => f.includes(frag))) return false;
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
  return scanProgram(program, checker, isInScope);
}

// Core scan, parameterized on the program + an in-scope predicate so the in-memory self-test
// fixtures (--selftest) exercise the exact same detector/annotation logic as the real sweep.
function scanProgram(
  program: ts.Program,
  checker: ts.TypeChecker,
  inScope: (fileName: string) => boolean
): ScanResult {
  const found = new Map<string, Violation>();
  const legacyAnnotations = new Map<string, LegacyAnnotation>();
  const annotationErrors: AnnotationError[] = [];

  const add = (v: Violation) => {
    found.set(violationKey(v), v);
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!inScope(sf.fileName)) continue;
    const file = repoRel(sf.fileName);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const methodAccess = node.expression;
        const method = methodAccess.name.text;
        const kind = methodKind(method);
        const delegateAccess = methodAccess.expression;
        if (kind && ts.isPropertyAccessExpression(delegateAccess)) {
          const delegateName = delegateAccess.name.text;

          // Detector (i): run-graph delegate on a control-plane client.
          if (RUN_GRAPH_DELEGATES.has(delegateName)) {
            const clientKind = classifyType(checker, checker.getTypeAtLocation(delegateAccess));
            if (clientKind === "cp") {
              const receiverExpr = delegateAccess.expression;
              const isLegacy = receiverIsLegacyHandle(checker, receiverExpr);
              const line = lineOf(sf, delegateAccess.name);
              // (existing) A provably-legacy-only model reached via a legacy handle is allowed
              // outright — no annotation needed.
              const modelAllowedLegacy = LEGACY_ONLY_DELEGATES.has(delegateName) && isLegacy;

              if (!modelAllowedLegacy) {
                const legacyReason = annotationReasonForNode(sf, node, LEGACY_OK_TAG);
                const routedReason = annotationReasonForNode(sf, node, ROUTED_OK_TAG);
                const receiver = receiverExpr.getText(sf).replace(/\s+/g, " ").trim().slice(0, 120);

                if (legacyReason !== undefined) {
                  // MECH-1: honor only on a legacy handle (or a tx originating from one); otherwise
                  // the annotation is REJECTED (never suppresses, always fails --check).
                  if (isLegacy) {
                    const ann = { file, line, reason: legacyReason, receiver };
                    legacyAnnotations.set(annotationKey(ann), ann);
                  } else {
                    annotationErrors.push({
                      file,
                      line,
                      receiver,
                      message: "runops-legacy-ok on a non-legacy receiver",
                    });
                  }
                } else if (
                  routedReason !== undefined &&
                  isInsideReadThroughContext(checker, node, receiverExpr)
                ) {
                  // MECH-2 fallback: residency-routed read inside a read-through router — allowed.
                } else {
                  add({
                    file,
                    line,
                    model: capFirst(delegateName),
                    delegate: delegateName,
                    callKind: kind,
                    detector: "i",
                    snippet: lineText(sf, line),
                  });
                }
              }
            }
          }

          // Detector (ii): cross-seam include/select traversal (any control-plane delegate).
          const rootModel = delegateToModel.get(delegateName);
          if (rootModel) {
            const hits = collectCrossSeamHits(checker, node.arguments[0], rootModel);
            if (hits.length) {
              const clientKind = classifyType(checker, checker.getTypeAtLocation(delegateAccess));
              if (clientKind === "cp") {
                for (const hit of hits) {
                  const line = lineOf(sf, hit.keyNode);
                  add({
                    file,
                    line,
                    model: hit.ownerModel,
                    delegate: hit.relation,
                    callKind: kind,
                    detector: "ii",
                    snippet: lineText(sf, line),
                  });
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
          add({
            file,
            line,
            model: capFirst(key),
            delegate: key,
            callKind: "read",
            detector: "iii",
            snippet: lineText(sf, line),
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  return {
    violations: sortViolations(Array.from(found.values())),
    legacyAnnotations: sortAnnotations(Array.from(legacyAnnotations.values())),
    annotationErrors: annotationErrors.sort((a, b) =>
      a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line
    ),
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

function sortAnnotations(as: LegacyAnnotation[]): LegacyAnnotation[] {
  return as.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.receiver !== b.receiver) return a.receiver < b.receiver ? -1 : 1;
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline IO
// ─────────────────────────────────────────────────────────────────────────────

type Baseline = {
  $comment: string;
  regenerate: string;
  runGraphModels: string[];
  crossSeamRelations: string[];
  totals: {
    violations: number;
    detectorI: number;
    detectorII: number;
    detectorIII: number;
    write: number;
    read: number;
    files: number;
    legacyAnnotations: number;
  };
  violations: Violation[];
  // Companion allowlist: honored MECH-1 `runops-legacy-ok` sites. Re-verified each --check run;
  // a stale/moved/re-worded annotation (or an unrecorded new one) fails the gate.
  legacyAnnotations: LegacyAnnotation[];
};

function buildBaseline(result: ScanResult): Baseline {
  const { violations, legacyAnnotations } = result;
  return {
    $comment:
      "Track-1 run-ops legacy guard baseline. Generated by apps/webapp/scripts/runOpsLegacyGuard.ts. " +
      "Each entry is a code path that reaches a run-graph table through the control-plane Prisma client " +
      "(detector i) or traverses a cross-seam relation (detector ii). This list IS the Track-1 work " +
      "list; burn it down to zero. legacyAnnotations records honored `runops-legacy-ok` sites. " +
      "Do NOT edit by hand — regenerate instead.",
    regenerate: "pnpm --filter webapp run guard:runops-legacy",
    runGraphModels: Array.from(RUN_GRAPH_MODELS).sort(),
    crossSeamRelations: crossSeamRelationList,
    totals: {
      violations: violations.length,
      detectorI: violations.filter((v) => v.detector === "i").length,
      detectorII: violations.filter((v) => v.detector === "ii").length,
      detectorIII: violations.filter((v) => v.detector === "iii").length,
      write: violations.filter((v) => v.callKind === "write").length,
      read: violations.filter((v) => v.callKind === "read").length,
      files: new Set(violations.map((v) => v.file)).size,
      legacyAnnotations: legacyAnnotations.length,
    },
    violations,
    legacyAnnotations,
  };
}

function writeBaseline(baseline: Baseline): void {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
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
const VIRTUAL_MODULE_MAP: Record<string, string> = {
  "@trigger.dev/database": VIRTUAL_CP_DTS,
  "@internal/run-ops-database": VIRTUAL_RUNOPS_DTS,
};

const VIRTUAL_CP_SOURCE = `
export interface TaskRunDelegate { create(a?:any):any; createMany(a?:any):any; update(a?:any):any; updateMany(a?:any):any; upsert(a?:any):any; delete(a?:any):any; deleteMany(a?:any):any; findFirst(a?:any):any; findMany(a?:any):any; count(a?:any):any; }
export interface TaskRunAttemptDelegate { create(a?:any):any; update(a?:any):any; }
export interface BatchTaskRunDelegate { findFirst(a?:any):any; update(a?:any):any; }
export interface WaitpointDelegate { findFirst(a?:any):any; }
export interface ProjectDelegate { findFirst(a?:any):any; findMany(a?:any):any; }
export declare class PrismaClient { taskRun: TaskRunDelegate; taskRunAttempt: TaskRunAttemptDelegate; batchTaskRun: BatchTaskRunDelegate; waitpoint: WaitpointDelegate; project: ProjectDelegate; }
export type PrismaReplicaClient = PrismaClient;
`;

const VIRTUAL_RUNOPS_SOURCE = `
export interface RunOpsTaskRunDelegate { create(a?:any):any; update(a?:any):any; updateMany(a?:any):any; findFirst(a?:any):any; findMany(a?:any):any; }
export declare class RunOpsPrismaClient { taskRun: RunOpsTaskRunDelegate; }
`;

type SelfTestExpect = { violations: number; honored: number; errors: number };
type SelfTestFixture = { name: string; code: string; expect: SelfTestExpect };

const SELF_TEST_FIXTURES: SelfTestFixture[] = [
  {
    // MECH-1 REJECTED: runops-legacy-ok on a bare control-plane receiver is an annotation error.
    name: "legacyOkBarePrisma",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const prisma: PrismaClient;
function f() {
  prisma.taskRun.update({ where: {}, data: {} }); // runops-legacy-ok: bogus on control-plane
}`,
    expect: { violations: 0, honored: 0, errors: 1 },
  },
  {
    // MECH-1 honored: runops-legacy-ok on the legacy handle.
    name: "legacyOkLegacyHandle",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const runOpsLegacyPrisma: PrismaClient;
function f() {
  runOpsLegacyPrisma.taskRun.update({ where: {}, data: {} }); // runops-legacy-ok: legacy cuid write
}`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    // Tx-origin walk: a tx from $transaction(runOpsLegacyPrisma, …) is a legacy handle — the
    // annotated taskRun write is honored and the legacy-only taskRunAttempt write is auto-exempt.
    name: "txFromLegacyTransaction",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const runOpsLegacyPrisma: PrismaClient;
declare function $transaction<R>(client: PrismaClient, name: string, fn: (tx: PrismaClient) => R): R;
function f() {
  $transaction(runOpsLegacyPrisma, "x", (tx: PrismaClient) => {
    tx.taskRun.update({ where: {}, data: {} }); // runops-legacy-ok: run bump inside legacy tx
    tx.taskRunAttempt.create({ data: {} });
    return 0;
  });
}`,
    expect: { violations: 0, honored: 1, errors: 0 },
  },
  {
    // Tx-origin negative: a tx from runInTransaction(runId, …) is routed, not legacy — the
    // annotation is rejected.
    name: "txFromRoutedRunInTransaction",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare function runInTransaction<R>(runId: string, fn: (tx: PrismaClient) => R): R;
function f() {
  runInTransaction("run_x", (tx: PrismaClient) => {
    tx.taskRun.update({ where: {}, data: {} }); // runops-legacy-ok: not actually legacy
    return 0;
  });
}`,
    expect: { violations: 0, honored: 0, errors: 1 },
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
    // MECH-2 primary: a receiver retyped to RunOpsPrismaClient classifies as runops — no violation.
    name: "runopsRebrand",
    code: `import { RunOpsPrismaClient } from "@internal/run-ops-database";
declare const runOpsLegacyPrismaClient: RunOpsPrismaClient;
function f() {
  runOpsLegacyPrismaClient.taskRun.update({ where: {}, data: {} });
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
  },
  {
    // MECH-2 fallback: runops-routed-ok inside a read-through router is honored (suppressed).
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
    expect: { violations: 0, honored: 0, errors: 0 },
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
    // Existing model-level exemption: a legacy-only delegate on the legacy handle needs no annotation.
    name: "legacyOnlyExempt",
    code: `import { PrismaClient } from "@trigger.dev/database";
declare const runOpsLegacyPrisma: PrismaClient;
function f() {
  runOpsLegacyPrisma.taskRunAttempt.create({ data: {} });
}`,
    expect: { violations: 0, honored: 0, errors: 0 },
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
  };
  const fixturePaths = new Set<string>();
  for (const fx of SELF_TEST_FIXTURES) {
    const p = `/virtual/fixtures/${fx.name}.ts`;
    files[p] = fx.code;
    fixturePaths.add(p);
  }

  const program = buildVirtualProgram(files);
  const checker = program.getTypeChecker();
  const result = scanProgram(program, checker, (fileName) => fixturePaths.has(fileName));

  const failures: string[] = [];
  for (const fx of SELF_TEST_FIXTURES) {
    const violations = result.violations.filter((v) => v.file.includes(fx.name)).length;
    const honored = result.legacyAnnotations.filter((a) => a.file.includes(fx.name)).length;
    const errors = result.annotationErrors.filter((e) => e.file.includes(fx.name)).length;
    const got = { violations, honored, errors };
    if (
      got.violations !== fx.expect.violations ||
      got.honored !== fx.expect.honored ||
      got.errors !== fx.expect.errors
    ) {
      failures.push(
        `${fx.name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(fx.expect)}`
      );
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

  if (RUN_GRAPH_MODELS.size !== 16) {
    console.error(
      `Expected 16 run-graph models from ${repoRel(RUNOPS_SCHEMA)}, found ${RUN_GRAPH_MODELS.size}. ` +
        `Update the guard if the run-graph model set changed.`
    );
    process.exit(2);
  }

  for (const dir of [CP_GENERATED_DIR, RUNOPS_GENERATED_DIR]) {
    if (!fs.existsSync(path.join(dir, "index.d.ts"))) {
      console.error(
        `[runops-guard] generated Prisma client missing at ${repoRel(dir)} — run: pnpm run generate`
      );
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
  const { violations, legacyAnnotations, annotationErrors } = result;
  const baseline = buildBaseline(result);

  console.error(
    `[runops-guard] found ${violations.length} violations ` +
      `(detector-i: ${baseline.totals.detectorI}, detector-ii: ${baseline.totals.detectorII}, detector-iii: ${baseline.totals.detectorIII}; ` +
      `write: ${baseline.totals.write}, read: ${baseline.totals.read}; files: ${baseline.totals.files}); ` +
      `honored runops-legacy-ok: ${legacyAnnotations.length}`
  );

  // A rejected annotation is a hard misuse — it can never be baselined or suppressed, so it fails
  // both modes. Report it before anything else.
  const reportAnnotationErrors = () => {
    if (!annotationErrors.length) return;
    console.error(`\n[runops-guard] ${annotationErrors.length} invalid annotation(s):\n`);
    for (const e of annotationErrors) {
      console.error(`  ${e.file}:${e.line}  ${e.message}  (receiver: ${e.receiver})`);
    }
    console.error(
      `\n\`// ${LEGACY_OK_TAG}: …\` is honored only on a legacy handle (runOpsLegacyPrisma/Replica) ` +
        `or a tx originating from one. Route through the RunStore, or land the write on the legacy handle.`
    );
  };

  if (!check) {
    writeBaseline(baseline);
    console.error(`[runops-guard] baseline written to ${repoRel(BASELINE_PATH)}`);
    for (const v of violations) {
      console.log(
        `${v.file}:${v.line}  [${v.detector}/${v.callKind}]  ${v.model}.${v.delegate}  ${v.snippet}`
      );
    }
    reportAnnotationErrors();
    if (annotationErrors.length) process.exit(1);
    return;
  }

  const parsed = readBaseline();
  const baselineKeys = new Set((parsed.violations ?? []).map(violationKey));
  const currentKeys = new Set(violations.map(violationKey));
  const added = violations.filter((v) => !baselineKeys.has(violationKey(v)));
  const removed = Array.from(baselineKeys).filter((k) => !currentKeys.has(k));

  // Re-verify the honored-annotation companion block: current set must match the baseline exactly.
  const baselineAnnKeys = new Set((parsed.legacyAnnotations ?? []).map(annotationKey));
  const currentAnnKeys = new Set(legacyAnnotations.map(annotationKey));
  const staleAnn = (parsed.legacyAnnotations ?? []).filter(
    (a) => !currentAnnKeys.has(annotationKey(a))
  );
  const newAnn = legacyAnnotations.filter((a) => !baselineAnnKeys.has(annotationKey(a)));

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
      `\nRun-graph tables must be reached via the RunStore (or a proven-legacy handle), not the ` +
        `control-plane client. See PLAN §T1.1 patterns (A)/(B)/(C). If this is legitimately new ` +
        `baseline work, regenerate with: pnpm --filter webapp run guard:runops-legacy`
    );
    failed = true;
  }

  if (staleAnn.length || newAnn.length) {
    console.error(
      `\n[runops-guard] honored runops-legacy-ok annotations drifted from the baseline companion block:`
    );
    for (const a of staleAnn) {
      console.error(`  - stale/moved: ${a.file}:${a.line}  (receiver: ${a.receiver})  ${a.reason}`);
    }
    for (const a of newAnn) {
      console.error(`  + unrecorded:  ${a.file}:${a.line}  (receiver: ${a.receiver})  ${a.reason}`);
    }
    console.error(
      `\nEvery honored annotation must be recorded verbatim. Regenerate the baseline: ` +
        `pnpm --filter webapp run guard:runops-legacy`
    );
    failed = true;
  }

  if (annotationErrors.length) {
    reportAnnotationErrors();
    failed = true;
  }

  if (failed) process.exit(1);

  console.error(`[runops-guard] OK — no new violations beyond the baseline.`);
}

main();
