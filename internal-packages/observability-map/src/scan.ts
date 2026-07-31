import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryPoint } from "./types.js";

/** Thrown by `scanFile` when the source does not parse cleanly. */
export class ParseFailureError extends Error {
  constructor(
    readonly fileName: string,
    readonly diagnostic: string
  ) {
    super(`${fileName}: ${diagnostic}`);
    this.name = "ParseFailureError";
  }
}

type EntryFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isEntryFunction(node: ts.Node): node is EntryFunction {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  );
}

/** Strip wrappers that do not change which expression is really being referred to. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Root callee of a call, unwrapping chains: `createLoaderApiRoute({}).withCors()`
 * resolves to `createLoaderApiRoute`, not `withCors`.
 */
function rootCalleeName(call: ts.CallExpression): string | null {
  let current: ts.Expression = unwrap(call.expression);
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isCallExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = unwrap(current.expression);
      continue;
    }
    return null;
  }
}

/** Callee as recorded in `calleeNames`: the identifier, or the property for a member call. */
function calleeName(expr: ts.Expression): string | null {
  const target = unwrap(expr);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

/**
 * Functions on a `handler` property of an object argument, e.g. `createSSELoader({ handler })` and
 * the per-method `{ POST: { handler } }` map. Only `handler` counts: the surrounding config also
 * holds lambdas (`findResource`, `authorization.resource`) that are not the entry-point body.
 */
function collectNamedHandlers(object: ts.ObjectLiteralExpression, out: EntryFunction[]): void {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !property.name) continue;
    const value = unwrap(property.initializer);
    if (ts.isObjectLiteralExpression(value)) {
      collectNamedHandlers(value, out);
      continue;
    }
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    if (name === "handler" && isEntryFunction(value)) out.push(value);
  }
}

/** Every function passed as an argument anywhere in a call chain, e.g. the builder's handler. */
function collectHandlerFunctions(expr: ts.Expression, out: EntryFunction[]): void {
  const target = unwrap(expr);
  if (ts.isCallExpression(target)) {
    for (const arg of target.arguments) {
      const unwrapped = unwrap(arg);
      if (isEntryFunction(unwrapped)) out.push(unwrapped);
      else if (ts.isObjectLiteralExpression(unwrapped)) collectNamedHandlers(unwrapped, out);
    }
    collectHandlerFunctions(target.expression, out);
    return;
  }
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    collectHandlerFunctions(target.expression, out);
  }
}

type Initializer = { callee: string | null; functions: EntryFunction[] };

const NO_INITIALIZER: Initializer = { callee: null, functions: [] };

/** Top-level `function x` / `const x = ...` declarations, keyed by binding name. */
type LocalDeclarations = Map<string, ts.Expression | ts.FunctionDeclaration>;

function analyzeInitializer(
  expr: ts.Expression | undefined,
  locals: LocalDeclarations,
  seen: Set<string>
): Initializer {
  if (!expr) return NO_INITIALIZER;
  const target = unwrap(expr);

  if (isEntryFunction(target)) return { callee: null, functions: [target] };

  if (ts.isCallExpression(target)) {
    const functions: EntryFunction[] = [];
    collectHandlerFunctions(target, functions);
    return { callee: rootCalleeName(target), functions };
  }

  // `export const action = route.action` where `const route = createActionApiRoute(...)`, and the
  // plain alias `export const loader = h`. Resolve back to the declaration the name came from.
  if (ts.isIdentifier(target)) return resolveLocal(target.text, locals, seen);
  if (ts.isPropertyAccessExpression(target)) {
    const root = unwrap(target.expression);
    if (ts.isIdentifier(root)) return resolveLocal(root.text, locals, seen);
  }

  return NO_INITIALIZER;
}

function resolveLocal(name: string, locals: LocalDeclarations, seen: Set<string>): Initializer {
  if (seen.has(name)) return NO_INITIALIZER;
  seen.add(name);
  const local = locals.get(name);
  if (!local) return NO_INITIALIZER;
  if (ts.isFunctionDeclaration(local)) return { callee: null, functions: [local] };
  return analyzeInitializer(local, locals, seen);
}

/**
 * Statements in a statement, counting through block-bearing statements so a body wrapped in a
 * single `try` reports its real size. Does not descend into nested function bodies.
 */
function countStatement(statement: ts.Statement): number {
  if (ts.isBlock(statement)) {
    return countStatements(statement.statements);
  }

  let count = 1;

  if (ts.isTryStatement(statement)) {
    count += countStatements(statement.tryBlock.statements);
    if (statement.catchClause) count += countStatements(statement.catchClause.block.statements);
    if (statement.finallyBlock) count += countStatements(statement.finallyBlock.statements);
    return count;
  }

  if (ts.isIfStatement(statement)) {
    count += countStatement(statement.thenStatement);
    if (statement.elseStatement) count += countStatement(statement.elseStatement);
    return count;
  }

  if (
    ts.isForStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement) ||
    ts.isLabeledStatement(statement) ||
    ts.isWithStatement(statement)
  ) {
    count += countStatement(statement.statement);
    return count;
  }

  if (ts.isSwitchStatement(statement)) {
    for (const clause of statement.caseBlock.clauses) {
      count += countStatements(clause.statements);
    }
    return count;
  }

  return count;
}

function countStatements(statements: ts.NodeArray<ts.Statement>): number {
  let count = 0;
  for (const statement of statements) count += countStatement(statement);
  return count;
}

function countFunctionStatements(fn: EntryFunction): number {
  if (!fn.body) return 0;
  // A concise arrow body (`() => json({})`) is one expression, so one statement.
  if (!ts.isBlock(fn.body)) return 1;
  return countStatements(fn.body.statements);
}

type EntryTarget = {
  hasLoader: boolean;
  hasAction: boolean;
  loaderInitializerCallee: string | null;
  actionInitializerCallee: string | null;
  functions: Set<EntryFunction>;
};

/**
 * Top-level `function x` / `const x = ...` declarations by binding name, so a named export clause
 * (`export { action }`) can be resolved back to the initializer it came from.
 */
function collectLocalDeclarations(sf: ts.SourceFile): LocalDeclarations {
  const locals: LocalDeclarations = new Map();

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      locals.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (ts.isIdentifier(decl.name)) {
        locals.set(decl.name.text, decl.initializer);
        continue;
      }
      if (ts.isObjectBindingPattern(decl.name)) {
        for (const element of decl.name.elements) {
          if (ts.isIdentifier(element.name)) locals.set(element.name.text, decl.initializer);
        }
      }
    }
  }

  return locals;
}

export function scanFile(fileName: string, source: string): EntryPoint | null {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  // `createSourceFile` recovers from malformed input instead of throwing, so the diagnostics are
  // the only signal that a file did not parse.
  const parseDiagnostics = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    const first = parseDiagnostics[0]!;
    throw new ParseFailureError(fileName, ts.flattenDiagnosticMessageText(first.messageText, " "));
  }

  const importedNames: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) importedNames.push(el.name.text);
    }
    if (statement.importClause.name) importedNames.push(statement.importClause.name.text);
  }

  const target: EntryTarget = {
    hasLoader: false,
    hasAction: false,
    loaderInitializerCallee: null,
    actionInitializerCallee: null,
    functions: new Set(),
  };

  const record = (name: string, initializer: Initializer) => {
    if (name === "loader") {
      target.hasLoader = true;
      target.loaderInitializerCallee ??= initializer.callee;
    } else {
      target.hasAction = true;
      target.actionInitializerCallee ??= initializer.callee;
    }
    for (const fn of initializer.functions) target.functions.add(fn);
  };

  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;

  const locals = collectLocalDeclarations(sf);

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      const name = statement.name.text;
      if (name === "loader" || name === "action") {
        record(name, { callee: null, functions: [statement] });
      }
      continue;
    }

    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        if (name === "loader" || name === "action") {
          record(name, analyzeInitializer(decl.initializer, locals, new Set()));
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      // `export * from "./x"` has no clause and reaches nothing here; `export * as ns from "./x"`
      // is a namespace clause, which cannot name a loader or action either.
      if (!ts.isNamedExports(statement.exportClause)) continue;

      for (const element of statement.exportClause.elements) {
        const exportedName = element.name.text;
        if (exportedName !== "loader" && exportedName !== "action") continue;
        // A re-export (`export { loader } from "./x"`) has no local binding to resolve.
        if (statement.moduleSpecifier) {
          record(exportedName, NO_INITIALIZER);
          continue;
        }
        const localName = element.propertyName?.text ?? exportedName;
        record(exportedName, resolveLocal(localName, locals, new Set()));
      }
    }
  }

  if (!target.hasLoader && !target.hasAction) return null;

  let statementCount = 0;
  let hasTryCatch = false;
  const calleeNames: string[] = [];

  for (const fn of target.functions) {
    statementCount += countFunctionStatements(fn);

    if (!fn.body) continue;
    const visit = (node: ts.Node) => {
      if (ts.isTryStatement(node)) hasTryCatch = true;
      if (ts.isCallExpression(node)) {
        const cn = calleeName(node.expression);
        if (cn) calleeNames.push(cn);
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
  }

  return {
    fileName,
    source,
    hasLoader: target.hasLoader,
    hasAction: target.hasAction,
    loaderInitializerCallee: target.loaderInitializerCallee,
    actionInitializerCallee: target.actionInitializerCallee,
    importedNames,
    calleeNames,
    hasTryCatch,
    statementCount,
  };
}

const SOURCE_FILE = /\.tsx?$/;

function isScannableFile(fileName: string): boolean {
  return SOURCE_FILE.test(fileName) && !fileName.endsWith(".d.ts");
}

export function scanDirectory(dir: string): {
  entryPoints: EntryPoint[];
  parseFailures: string[];
} {
  const entryPoints: EntryPoint[] = [];
  const parseFailures: string[] = [];

  const scan = (absolutePath: string, relativeName: string) => {
    try {
      const ep = scanFile(relativeName, readFileSync(absolutePath, "utf8"));
      if (ep) entryPoints.push(ep);
    } catch {
      parseFailures.push(relativeName);
    }
  };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Flat-route directories hold the route module in `route.ts`/`route.tsx`.
      for (const child of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (!child.isFile() || (child.name !== "route.ts" && child.name !== "route.tsx")) continue;
        scan(join(dir, entry.name, child.name), `${entry.name}/${child.name}`);
      }
      continue;
    }
    if (!entry.isFile() || !isScannableFile(entry.name)) continue;
    scan(join(dir, entry.name), entry.name);
  }

  return { entryPoints, parseFailures };
}
