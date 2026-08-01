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

function isParseCall(node: ts.Node): boolean {
  if (ts.isNewExpression(node)) {
    return ts.isIdentifier(node.expression) && PARSE_CONSTRUCTORS.has(node.expression.text);
  }
  if (!ts.isCallExpression(node)) return false;
  const text = calleeText(node.expression) ?? calleeName(node.expression);
  return text !== null && PARSE_CALLEE.test(text);
}

/**
 * Body reads: the thing a parse guard waits for before it parses. `request.json()` is in
 * `PARSE_CALLEE` already because it reads and parses in one call, and these are the same operation
 * with the parse written separately, `const raw = await request.text(); new RegExp(raw);`.
 *
 * Only consulted for `awaitsOnlyParse`, never for `guardsParse`, which is what bounds it: a body
 * read on its own still does not make a try block a parse guard, so the widest this list can do is
 * let a block that already parses also read the thing it parses.
 */
const BODY_READ_METHODS = new Set(["text", "formData", "arrayBuffer", "blob", "bytes"]);

function isBodyRead(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  return ts.isPropertyAccessExpression(callee) && BODY_READ_METHODS.has(callee.name.text);
}

/**
 * What the guarded region does, in the two terms `error-classification` needs to tell a parse guard
 * from a handler wrapped around a parse.
 *
 * `guardsParse` is whether anything in it parses at all. A `new URL(x)` counts and has to be read
 * as a `ts.isNewExpression` here, because the call-callee scan that builds `calleeNames` never sees
 * it.
 *
 * `awaitsOnlyParse` is whether everything the block waits for is a parse or a read of the body it
 * parses. Awaiting is the signal, not calling: the calls that prepare a parse's input are ordinary
 * synchronous string work (`matchPattern.startsWith("(?i)")`, `.slice(4)` before a `new RegExp`),
 * and refusing those refuses four of the tree's clearest guards, while the swallow this has to
 * catch reaches a service: `try { const body = await request.json(); return await
 * handleEverything(body); }`.
 *
 * Nested function bodies are skipped: a callback written inside the try is not work the try is
 * guarding on this pass through.
 */
function guardedWork(tryBlock: ts.Block): { guardsParse: boolean; awaitsOnlyParse: boolean } {
  let guardsParse = false;
  let awaitsOnlyParse = true;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (isParseCall(node)) guardsParse = true;
    if (ts.isAwaitExpression(node)) {
      const awaited = unwrap(node.expression);
      if (!isParseCall(awaited) && !isBodyRead(awaited)) awaitsOnlyParse = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(tryBlock);
  return { guardsParse, awaitsOnlyParse };
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
 * word what it says. The caller only offers it the whole value of a `return`/`throw`, so
 * `return e instanceof Response ? e : json({}, { status: 500 })` reaches here and
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
  return referencesBinding(node.condition, bindingName);
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

/** Whether the tree rooted at `node` contains a `return` or a `throw` of its own, not counting one
 * inside a nested function. What separates an arm that takes the error somewhere from an arm that
 * runs and falls back into the clause's single common exit. */
function containsExit(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  return ts.forEachChild(node, containsExit) === true;
}

/**
 * Whether an `if`/`switch` sends at least one arm somewhere the others do not go, by returning or
 * throwing from inside it. `if (e instanceof Error) { }` and `if (e instanceof Error) { log(e); }`
 * both fail this: every error still leaves the clause by the same path afterwards, so the test
 * changed the wording and not the outcome. The empty-body form was the cheapest no-op in the tool,
 * worth 50 points a route; `empty-instanceof-if` in the mutation corpus is the tree-scale version.
 *
 * Two arms that return the SAME value pass this and should not. That residual is written down in
 * the round A fix 2 report rather than defended: telling two returns apart needs the values
 * compared, which is a different kind of analysis from anything else here.
 */
function selectsADistinctPath(statement: ts.IfStatement | ts.SwitchStatement): boolean {
  if (ts.isIfStatement(statement)) {
    return (
      containsExit(statement.thenStatement) ||
      (statement.elseStatement !== undefined && containsExit(statement.elseStatement))
    );
  }
  return statement.caseBlock.clauses.some((clause) => clause.statements.some(containsExit));
}

/**
 * What a catch clause does with the error, beyond the fact that it caught one.
 *
 * Both answers are read off the clause's own straight-line path: the statements of its block, cut
 * at the first one that definitely exits, recursing into a bare nested block and nothing else. A
 * `throw` or a test that sits inside an `if`, a loop, a `switch`, a nested `try` or a callback is
 * not on that path, so it does not count.
 *
 * That is the whole dead-code defence, and it replaces the list of statically-false shapes the
 * previous round kept extending. The list was losing: `if (false)` and `while (false)` were
 * recognised, and `for (;false;)`, `if (true) {} else`, `switch (1) { case 2: }`, `try {} catch`,
 * `for (const x of [])`, `for (const k in {})`, `if ("")`, `if (!true)` and `if (1 === 2)` were not,
 * each worth 50 points a route. Asking for the throw to be unconditional refuses all eleven without
 * naming any of them, and refuses the twelfth nobody has written yet. `dead-*` in the mutation
 * corpus is the tree-scale proof, one entry per shape.
 *
 * The cost is real: `catch (e) { if (transient) throw e; return null; }` no longer reads as a
 * rethrow, so it reads as a swallow and fails rather than sitting out. That is the direction to be
 * wrong in, since the reverse hands out points.
 */
function catchClauseEvidence(clause: ts.CatchClause): { rethrows: boolean; branches: boolean } {
  let rethrows = false;
  let branches = false;
  const bindingName = catchBindingName(clause);

  const walk = (statements: readonly ts.Statement[]) => {
    // A block that re-declares the binding name means an `if` below it referencing that name is
    // referencing the shadowing declaration, not this clause's error. Nothing in such a block can
    // speak for the clause, so the whole list is skipped for branch purposes.
    const shadowed = bindingName !== null && declaresInScope(statements, bindingName);

    for (const statement of reachableStatements(statements)) {
      if (ts.isThrowStatement(statement)) {
        rethrows = true;
        continue;
      }
      if (ts.isBlock(statement)) {
        walk(statement.statements);
        continue;
      }
      // A `do` body runs before its condition is ever read, so it is on the straight-line path
      // whatever the condition says. The only loop form that is.
      if (ts.isDoStatement(statement)) {
        const body = statement.statement;
        walk(ts.isBlock(body) ? body.statements : [body]);
        continue;
      }
      if (bindingName === null || shadowed) continue;

      if (
        (ts.isIfStatement(statement) || ts.isSwitchStatement(statement)) &&
        referencesBinding(statement.expression, bindingName) &&
        selectsADistinctPath(statement)
      ) {
        branches = true;
        continue;
      }
      if (
        (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) &&
        statement.expression !== undefined
      ) {
        const value = unwrap(statement.expression);
        if (ts.isConditionalExpression(value) && selectsAnErrorPath(value, bindingName)) {
          branches = true;
        }
      }
    }
  };
  walk(clause.block.statements);

  return { rethrows, branches };
}

/**
 * Method names that invoke their callback once per element, never once as a whole. The structural
 * signal that separates a per-item boundary (`items.map((item) => { try {...} })`, a fresh catch
 * for every element) from a route's own body expressed through one more layer of function nesting
 * (`trace(async () => {...})`, `mutateWithFallback({ pgMutation: async (t) => {...} })`,
 * `new ReadableStream({ start: async (c) => {...} })`), all of which invoke their callback exactly
 * once.
 *
 * A name list, because nothing in a syntactic scan can tell `users.map` from `Result.map`. The
 * consequence is written down where it matters, on `isIterationCallback`.
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

/** Whether an expression is an array literal of fewer than two elements, the one receiver shape
 * that cannot be a per-item iteration however the method is named. */
function isAtMostSingletonArray(expr: ts.Expression): boolean {
  const target = unwrap(expr);
  return ts.isArrayLiteralExpression(target) && target.elements.length < 2;
}

/**
 * Whether the function-like `node` is the callback argument of a per-item iteration, e.g. the arrow
 * function in `items.map((item) => ...)`.
 *
 * Being wrong here is asymmetric. Calling a per-item callback the route's own continuation
 * mis-attributes a per-element catch to the route, which was the bug the boundary was added for.
 * Calling the route's own continuation a per-item callback hides the route's catch, and
 * `error-classification` used to read a route with no catch as not-applicable, which is 50 points
 * more than the swallow it was hiding. So the second direction paid, and `[0].map(async () => {
 * whole body })` collected it.
 *
 * Two things changed. A receiver that is an array literal of one element or none is refused here,
 * because it cannot iterate. And the direction that pays no longer pays: `walkBody` counts the
 * catches it refuses, and `error-classification` fails a route whose only catches were refused
 * rather than excusing it. So a wrong answer here costs precision, not points. That is what makes
 * the name list survivable, and it is why `Result.map(...)`, which no name list can tell from
 * `users.map(...)`, is a corpus entry that passes rather than a hole.
 */
function isIterationCallback(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (!parent.arguments.includes(node as ts.Expression)) return false;
  const callee = unwrap(parent.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ITERATION_METHODS.has(callee.name.text)) return false;
  return !isAtMostSingletonArray(callee.expression);
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
 * How many operands a comma expression has, so `a(), b(), c()` is three and not one. Anything else
 * is one.
 */
function commaOperands(expr: ts.Expression): number {
  const target = unwrap(expr);
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return commaOperands(target.left) + commaOperands(target.right);
  }
  return 1;
}

/**
 * Statements in a statement, counting through block-bearing statements so a body wrapped in a
 * single `try` reports its real size. Does not descend into nested function bodies.
 *
 * Counts bindings and comma operands rather than semicolons, which is what makes the number mean
 * something. `const a = f(), b = g(), c = h();` is three initializers however it is punctuated, and
 * `a(), b(), c()` is three calls: scoring either as one let a seven-statement try be rewritten into
 * a two-statement one with no change to what it runs, which took `error-classification` from fail
 * to pass. `merge-declarations` and `merge-comma-expressions` in the mutation corpus are
 * the tree-scale versions.
 */
function countStatement(statement: ts.Statement): number {
  if (ts.isBlock(statement)) {
    return countStatements(statement.statements);
  }

  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.length;
  }

  if (ts.isExpressionStatement(statement)) {
    return commaOperands(statement.expression);
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
  let callbackCatches = 0;
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
    // still inside it. `calleeNames` and `logCalls` keep descending regardless. A try/catch does
    // not: a per-item catch is not part of this body's own statement list, and `countStatement`
    // already stops at a nested function boundary, so counting it here let `tryStatementCount`
    // exceed the entry point's whole `statementCount` and judged a per-item error boundary as
    // though it were the route's own. What is refused is counted in `callbackCatches` instead of
    // dropped, so a route whose only error handling was refused is failed rather than excused.
    //
    // Only an iteration callback is a boundary, not every function-like node: a route's own body
    // wrapped in `trace(async () => {...})`, `mutateWithFallback({ pgMutation: async (t) => {...} })`
    // or `new ReadableStream({ start: async (c) => {...} })` still runs exactly once, as the route's
    // own continuation one layer of nesting away, and its catch is the route's own error handling.
    //
    // A nested function's statements count towards `statementCount` too, whichever kind it is.
    // They are work the route does, and leaving them out let `trace("x", async () => { whole body
    // })` collapse a route to one statement, which is inside the triviality rule's limit: the route
    // then read as trivial and every check reported not-applicable for it. `wrap-body-in-trace` in
    // the mutation corpus is that shape.
    const visit = (node: ts.Node, inCatch: boolean, inCallback: boolean) => {
      if (ts.isFunctionLike(node)) {
        if (isEntryFunction(node)) statementCount += countFunctionStatements(node);
        const entersIterationCallback = inCallback || isIterationCallback(node);
        ts.forEachChild(node, (child) => visit(child, inCatch, entersIterationCallback));
        return;
      }
      if (ts.isTryStatement(node)) {
        hasTryCatch = true;
        if (node.catchClause && inCallback) callbackCatches++;
        if (node.catchClause && !inCallback) {
          const tryStatementCount = countStatements(node.tryBlock.statements);
          const clause = catchClauseEvidence(node.catchClause);
          catches.push({
            rethrows: clause.rethrows,
            branches: clause.branches,
            ...guardedWork(node.tryBlock),
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
    callbackCatches,
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
