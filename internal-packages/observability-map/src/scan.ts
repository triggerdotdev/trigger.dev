import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatchEvidence, EntryPoint, LogCall } from "./types.js";

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
 * The whole callee path of a call, `prisma.organization.findFirst` rather than `findFirst`. Used to
 * match a call against `LOGGER_CALLEE` and `PARSE_CALLEE`. Null when the path runs through something
 * with no name of its own, e.g. `new PromptService().createOverride`, where the caller falls back to
 * the bare name.
 */
function calleeText(expr: ts.Expression): string | null {
  const target = unwrap(expr);
  if (ts.isIdentifier(target)) return target.text;
  if (target.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(target)) {
    const base = calleeText(target.expression);
    return base === null ? null : `${base}.${target.name.text}`;
  }
  if (ts.isCallExpression(target)) {
    const base = calleeText(target.expression);
    return base === null ? null : `${base}()`;
  }
  return null;
}

/** `logger.error`, `log.info`, `this.logger.debug`. */
const LOGGER_CALLEE = /(^|\.)(logger|log)\.[A-Za-z_$][\w$]*$/;

/** Property names on the first object-literal argument, e.g. `{ environmentId, error }`. */
function objectArgumentFields(call: ts.CallExpression): string[] {
  for (const arg of call.arguments) {
    const target = unwrap(arg);
    if (!ts.isObjectLiteralExpression(target)) continue;
    const fields: string[] = [];
    for (const property of target.properties) {
      const name = propertyName(property);
      if (name) fields.push(name);
    }
    return fields;
  }
  return [];
}

/**
 * Calls that turn input into a value and throw when it is malformed. `parse`/`safeParse` cover
 * `JSON.parse` and the zod schemas. `.json` has to be a member call, because a bare `json(...)` is
 * the remix response helper, which every route calls and which parses nothing.
 */
const PARSE_CALLEE = /(^|\.)(parse|safeParse|parseAsync|safeParseAsync|decode)$|\.json$/;

/**
 * Constructors that parse untrusted input and throw when it is malformed. Deliberately short: any
 * constructor at all would mean `new BranchesPresenter()` or `new Set(...)` excuses a catch that
 * guards ordinary work, which was true of 77 try blocks in the route tree.
 */
const PARSE_CONSTRUCTORS = new Set(["URL", "URLSearchParams", "RegExp"]);

/**
 * Whether the guarded region parses something. A `new URL(x)` counts, and has to be read here as a
 * `ts.isNewExpression`, because the call-callee scan that builds `calleeNames` never sees it.
 */
function guardsParse(tryBlock: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      PARSE_CONSTRUCTORS.has(node.expression.text)
    ) {
      found = true;
    }
    if (ts.isCallExpression(node)) {
      const text = calleeText(node.expression) ?? calleeName(node.expression);
      if (text !== null && PARSE_CALLEE.test(text)) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tryBlock);
  return found;
}

/** Whether some node in the tree rooted at `node` matches `predicate`. */
function someNode(node: ts.Node, predicate: (n: ts.Node) => boolean): boolean {
  if (predicate(node)) return true;
  return ts.forEachChild(node, (child) => someNode(child, predicate)) === true;
}

function containsInstanceOf(node: ts.Node): boolean {
  return someNode(
    node,
    (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
  );
}

/**
 * Whether a binding name pattern declares `target`, recursively: a plain `error`, a destructured
 * `{ error }` (shorthand) or `{ code: error }` (renamed), an array pattern `[error]`, and any of
 * those nested inside another. A destructured parameter or declaration re-declares the name just as
 * completely as a plain one does, so a shadow check that only recognised `ts.isIdentifier` missed
 * every destructured shape, function parameters and variable declarations alike.
 */
function bindingDeclares(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) return name.text === target;
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element) && bindingDeclares(element.name, target)) return true;
  }
  return false;
}

/** Whether `name` is declared by a var/let/const, function or class statement directly in this
 * statement list. Not recursive: a nested block's own declarations are handled when the walk
 * reaches that block. */
function declaresInScope(statements: readonly ts.Statement[], name: string): boolean {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return true;
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) return true;
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((d) => bindingDeclares(d.name, name))
    ) {
      return true;
    }
  }
  return false;
}

/** Whether a `for`/`for...of`/`for...in` loop's own declared variable is `name`, so its body
 * shadows the rest of the enclosing scope for that name. */
function declaresLoopVariable(
  node: ts.ForStatement | ts.ForOfStatement | ts.ForInStatement,
  name: string
): boolean {
  const initializer = node.initializer;
  return (
    initializer !== undefined &&
    ts.isVariableDeclarationList(initializer) &&
    initializer.declarations.some((d) => bindingDeclares(d.name, name))
  );
}

/**
 * Whether `node` contains a genuine read of the given catch binding, e.g. `e` in `e instanceof X`
 * or `error.code`. An identifier only counts when it is a real reference. Two shapes share the
 * binding's text without reading it: the property side of a member expression (`fallback.error`)
 * and an object literal key (`{ error: true }`), both excluded by checking which side of the
 * parent node the identifier sits on. A name re-declared in a nested scope, as a function or catch
 * parameter (including a destructured one) or as a var/let/const/function/class in a block, refers
 * to that declaration instead, so the walk stops at the boundary that re-declares it rather than
 * crediting the outer binding.
 */
function referencesBinding(node: ts.Node, bindingName: string): boolean {
  if (ts.isIdentifier(node) && node.text === bindingName) {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    return true;
  }

  if (
    ts.isFunctionLike(node) &&
    node.parameters.some((p) => bindingDeclares(p.name, bindingName))
  ) {
    return false;
  }

  if (ts.isCatchClause(node)) {
    const decl = node.variableDeclaration;
    if (decl && bindingDeclares(decl.name, bindingName)) return false;
  }

  if (ts.isBlock(node) && declaresInScope(node.statements, bindingName)) return false;

  return ts.forEachChild(node, (child) => referencesBinding(child, bindingName)) === true;
}

/** The catch binding's name, or null for a bindingless `catch { ... }` or a destructured one. */
function catchBindingName(clause: ts.CatchClause): string | null {
  const decl = clause.variableDeclaration;
  return decl && ts.isIdentifier(decl.name) ? decl.name.text : null;
}

/**
 * Whether a conditional expression tests the error to pick what the clause does, rather than to
 * word what it says. It counts only when the whole `return`/`throw` is the conditional, so
 * `return e instanceof Response ? e : json({}, { status: 500 })` counts and
 * `return json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })` does not.
 * The second is message formatting: every error leaves by the same path.
 *
 * Goes through `referencesBinding`, the same predicate the `if`/`switch` check uses, rather than
 * accepting any `instanceof` in the condition: an `instanceof` that never reads the caught binding
 * is not a decision made on the error, and a bindingless catch has nothing here to reference.
 */
function selectsAnErrorPath(node: ts.ConditionalExpression, bindingName: string | null): boolean {
  if (bindingName === null) return false;
  if (!containsInstanceOf(node.condition)) return false;
  if (!referencesBinding(node.condition, bindingName)) return false;
  const parent = node.parent;
  return parent !== undefined && (ts.isReturnStatement(parent) || ts.isThrowStatement(parent));
}

/** A statement that unconditionally leaves the statement list it sits in, so anything after it in
 * the same list never runs. */
function isDefiniteExit(statement: ts.Statement): boolean {
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isContinueStatement(statement) ||
    ts.isBreakStatement(statement)
  );
}

/**
 * `statements` up to and including the first one that definitely exits. Not full flow analysis:
 * an `if`/`else` where both branches return is not itself recognised as an exit, only a bare
 * `return`, `throw`, `continue` or `break` is. That is enough to make a `throw e;` appended after
 * a `return` dead code rather than evidence the clause rethrows, which is the one shape a mutation
 * testing this check actually produced.
 */
function reachableStatements(statements: readonly ts.Statement[]): readonly ts.Statement[] {
  const index = statements.findIndex(isDefiniteExit);
  return index === -1 ? statements : statements.slice(0, index + 1);
}

/**
 * A literal that is always falsy: `false`, `null`, `undefined`, `0`. Not general constant folding,
 * on purpose: `!true`, `1 === 2` and a reference to a `const` declared elsewhere are not covered, so
 * `if (false) { throw e; }` and `while (false) { throw e; }` are recognised as dead and nothing more
 * elaborate is claimed to be.
 */
function isFalsyLiteral(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.FalseKeyword || expr.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
  return ts.isNumericLiteral(expr) && expr.text === "0";
}

/**
 * What a catch clause does with the error, beyond the fact that it caught one.
 *
 * Stops at every function-like node, not only an iteration callback (contrast `walkBody`'s
 * boundary, which lets a route's own single-shot wrapper, `trace(async () => {...})`,
 * `mutateWithFallback({ pgMutation })`, `new ReadableStream({ start })`, through so the route's own
 * catch is found at all). Here the walk is already inside a catch clause that `walkBody` decided
 * belongs to the route; anything the clause does by constructing a further callback,
 * `queue.push(() => { throw e; })`, a `.then`, a `setTimeout`, is deferred work the clause merely
 * registers, not a decision it makes on its own execution. Both walks refuse a per-item iteration
 * callback; this one refuses every other kind of callback too, for that reason.
 */
function catchClauseEvidence(clause: ts.CatchClause): { rethrows: boolean; branches: boolean } {
  let rethrows = false;
  let branches = false;
  const bindingName = catchBindingName(clause);

  // `shadowed` is true once the walk has passed a scope that re-declares `bindingName`: a nested
  // catch clause with the same name, a `for`/`for...of`/`for...in` loop declaring it, or a block
  // that does (reusing the same `declaresInScope` a bare block already checks). From there on, an
  // `if`/`switch` that references the name textually is referencing the SHADOWING declaration, not
  // this clause's own binding, so it must not count as this clause deciding anything. Never reset
  // back to false, the same rule `inCallback` follows: once shadowed, everything nested inside is
  // still shadowed.
  const visit = (node: ts.Node, shadowed: boolean) => {
    if (ts.isFunctionLike(node)) return;

    if (bindingName !== null && ts.isCatchClause(node)) {
      const decl = node.variableDeclaration;
      const shadowsHere = decl !== undefined && bindingDeclares(decl.name, bindingName);
      ts.forEachChild(node, (child) => visit(child, shadowed || shadowsHere));
      return;
    }

    if (
      bindingName !== null &&
      (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      declaresLoopVariable(node, bindingName)
    ) {
      visit(node.statement, true);
      return;
    }

    if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const shadowedHere =
        shadowed || (bindingName !== null && declaresInScope(node.statements, bindingName));
      for (const statement of reachableStatements(node.statements)) visit(statement, shadowedHere);
      return;
    }

    if (ts.isThrowStatement(node)) rethrows = true;
    if (
      !shadowed &&
      bindingName !== null &&
      ((ts.isIfStatement(node) && referencesBinding(node.expression, bindingName)) ||
        (ts.isSwitchStatement(node) && referencesBinding(node.expression, bindingName)))
    ) {
      branches = true;
    }
    if (!shadowed && ts.isConditionalExpression(node) && selectsAnErrorPath(node, bindingName)) {
      branches = true;
    }

    // A statically-false condition makes the guarded statement dead code: it can set `branches`
    // above (the clause still decided to test the error, even if the arm never runs), but nothing
    // inside it can set `rethrows` or a nested `branches`, so it is not visited at all.
    if (ts.isIfStatement(node)) {
      if (!isFalsyLiteral(node.expression)) visit(node.thenStatement, shadowed);
      if (node.elseStatement) visit(node.elseStatement, shadowed);
      return;
    }
    if (ts.isWhileStatement(node)) {
      if (!isFalsyLiteral(node.expression)) visit(node.statement, shadowed);
      return;
    }

    ts.forEachChild(node, (child) => visit(child, shadowed));
  };
  visit(clause.block, false);

  return { rethrows, branches };
}

/**
 * Array methods that invoke their callback once per element, never once as a whole. The one
 * structural signal that separates a per-item boundary (`items.map((item) => { try {...} })`, a
 * fresh catch for every element) from a route's own body expressed through one more layer of
 * function nesting (`trace(async () => {...})`, `mutateWithFallback({ pgMutation: async (t) =>
 * {...} })`, `new ReadableStream({ start: async (c) => {...} })`), all of which invoke their
 * callback exactly once, as the route's own continuation.
 */
const ITERATION_METHODS = new Set([
  "map",
  "forEach",
  "filter",
  "reduce",
  "reduceRight",
  "flatMap",
  "some",
  "every",
]);

/** Whether the function-like `node` is the callback argument of a call to one of
 * `ITERATION_METHODS`, e.g. the arrow function in `items.map((item) => ...)`. */
function isIterationCallback(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (!parent.arguments.includes(node as ts.Expression)) return false;
  const callee = unwrap(parent.expression);
  return ts.isPropertyAccessExpression(callee) && ITERATION_METHODS.has(callee.name.text);
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!property.name) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    return property.name.text;
  return null;
}

/** `methods: { POST: { handler } }`, the per-method shape of `createMultiMethodApiRoute`. */
function collectMethodHandlers(methods: ts.ObjectLiteralExpression, out: EntryFunction[]): void {
  for (const method of methods.properties) {
    const name = propertyName(method);
    if (!name || !HTTP_METHODS.has(name)) continue;
    if (!ts.isPropertyAssignment(method)) continue;
    const config = unwrap(method.initializer);
    if (!ts.isObjectLiteralExpression(config)) continue;
    for (const property of config.properties) {
      if (!ts.isPropertyAssignment(property) || propertyName(property) !== "handler") continue;
      const value = unwrap(property.initializer);
      if (isEntryFunction(value)) out.push(value);
    }
  }
}

/**
 * The handler on an object argument, in the two shapes the route builders use: `handler` at the
 * top level of the config (`createSSELoader({ handler })`) and `methods.POST.handler`. Matching by
 * name at any depth would pick up an unrelated config callback that happens to be called
 * `handler`, as well as the sibling lambdas (`findResource`, `authorization.resource`) that are
 * not the entry-point body.
 */
function collectNamedHandlers(object: ts.ObjectLiteralExpression, out: EntryFunction[]): void {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property);
    const value = unwrap(property.initializer);
    if (name === "handler" && isEntryFunction(value)) out.push(value);
    if (name === "methods" && ts.isObjectLiteralExpression(value)) {
      collectMethodHandlers(value, out);
    }
  }
}

/** The innermost call of a chain: the `createLoaderApiRoute(...)` in `createLoaderApiRoute(...).withCors(...)`. */
function rootCall(call: ts.CallExpression): ts.CallExpression {
  let current = call;
  for (;;) {
    let next = unwrap(current.expression);
    while (ts.isPropertyAccessExpression(next) || ts.isElementAccessExpression(next)) {
      next = unwrap(next.expression);
    }
    if (ts.isCallExpression(next)) {
      current = next;
      continue;
    }
    return current;
  }
}

/**
 * The handler functions passed to a builder call. Only the root call of a chain is read: a
 * callback given to a decorator further along the chain (`.withCors(cb)`) is not the route body.
 */
function collectHandlerFunctions(call: ts.CallExpression, out: EntryFunction[]): void {
  for (const arg of rootCall(call).arguments) {
    const unwrapped = unwrap(arg);
    if (isEntryFunction(unwrapped)) out.push(unwrapped);
    else if (ts.isObjectLiteralExpression(unwrapped)) collectNamedHandlers(unwrapped, out);
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

/**
 * Top-level functions by name, for resolving a body that delegates its work to a same-file helper
 * (`export async function loader({ request }) { return proxyToPostHog(request); }`).
 */
function collectLocalFunctions(sf: ts.SourceFile): Map<string, EntryFunction> {
  const functions = new Map<string, EntryFunction>();

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      functions.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      const value = unwrap(decl.initializer);
      if (isEntryFunction(value)) functions.set(decl.name.text, value);
    }
  }

  return functions;
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
  const catches: CatchEvidence[] = [];
  const calleeNames: string[] = [];
  const logCalls: LogCall[] = [];

  const localFunctions = collectLocalFunctions(sf);
  // A body that delegates to a same-file helper does the work in that helper, so the helper's
  // statements, try/catch and callees belong to the entry point. One hop only: a helper's own
  // helpers are not followed, and the visited set stops a cycle and any double counting.
  const visited = new Set<EntryFunction>(target.functions);
  const helpers: EntryFunction[] = [];

  const walkBody = (fn: EntryFunction, followHelpers: boolean) => {
    statementCount += countFunctionStatements(fn);

    if (!fn.body) return;
    // `inCallback` is true once the walk has entered a per-item iteration callback
    // (`items.map((item) => { ... })`), never reset back to false: nesting deeper inside one is
    // still inside it. `calleeNames` and `logCalls` keep descending regardless, which is what lets
    // `isTrivial` see work a short statement count hides. A try/catch does not: a per-item catch is
    // not part of this body's own statement list, and `countStatement` already stops at a nested
    // function boundary, so counting it here let `tryStatementCount` exceed the entry point's whole
    // `statementCount` and judged a per-item error boundary as though it were the route's own.
    //
    // Only an iteration callback is a boundary, not every function-like node: a route's own body
    // wrapped in `trace(async () => {...})`, `mutateWithFallback({ pgMutation: async (t) => {...} })`
    // or `new ReadableStream({ start: async (c) => {...} })` still runs exactly once, as the route's
    // own continuation one layer of nesting away, and its catch is the route's own error handling.
    const visit = (node: ts.Node, inCatch: boolean, inCallback: boolean) => {
      if (ts.isFunctionLike(node)) {
        const entersIterationCallback = inCallback || isIterationCallback(node);
        ts.forEachChild(node, (child) => visit(child, inCatch, entersIterationCallback));
        return;
      }
      if (ts.isTryStatement(node)) {
        hasTryCatch = true;
        if (node.catchClause && !inCallback) {
          const tryStatementCount = countStatements(node.tryBlock.statements);
          const clause = catchClauseEvidence(node.catchClause);
          catches.push({
            rethrows: clause.rethrows,
            branches: clause.branches,
            guardsParse: guardsParse(node.tryBlock),
            tryStatementCount,
          });
        }
      }

      if (ts.isCatchClause(node)) {
        ts.forEachChild(node, (child) => visit(child, true, inCallback));
        return;
      }

      if (ts.isCallExpression(node)) {
        const cn = calleeName(node.expression);
        if (cn) {
          const text = calleeText(node.expression) ?? cn;
          calleeNames.push(cn);

          if (LOGGER_CALLEE.test(text)) {
            logCalls.push({
              callee: text,
              fields: objectArgumentFields(node),
              inCatch,
            });
          }
        }

        if (followHelpers) {
          const callee = unwrap(node.expression);
          if (ts.isIdentifier(callee)) {
            const helper = localFunctions.get(callee.text);
            if (helper && !visited.has(helper)) {
              visited.add(helper);
              helpers.push(helper);
            }
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, inCatch, inCallback));
    };
    visit(fn.body, false, false);
  };

  for (const fn of target.functions) walkBody(fn, true);
  for (const helper of helpers) walkBody(helper, false);

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
    catches,
    logCalls,
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
    let ep: EntryPoint | null;
    try {
      ep = scanFile(relativeName, readFileSync(absolutePath, "utf8"));
    } catch (error) {
      // Only a genuinely malformed source is a parse failure. An unreadable file or a bug in the
      // scanner must not be laundered into the same bucket, or a non-zero count means nothing.
      if (error instanceof ParseFailureError) {
        parseFailures.push(`${relativeName}: ${error.diagnostic}`);
        return;
      }
      throw error;
    }
    if (ep) entryPoints.push(ep);
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
