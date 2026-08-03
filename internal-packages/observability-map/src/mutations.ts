import ts from "typescript";

/**
 * Source-to-source mutations for the tree-scale corpus in `mutationCorpus.test.ts`.
 *
 * Every mutation here is a *text* rewrite driven by AST positions, never a reprint. A reprint would
 * change formatting everywhere and make a failure impossible to read; splicing at node positions
 * leaves the rest of the file byte-identical, so a corpus failure can be diffed down to the one
 * construct that moved.
 *
 * Two kinds of entry live in the corpus and they are labelled `preserving` and `deleting`:
 *
 * - `preserving`: the rewrite does not change what the route does. Dead code that can never run,
 *   a wrapper that runs the same statements once, a comment, a merge of adjacent `const`s. The
 *   property under test is the one the tool claims: no such edit may raise the score.
 * - `deleting`: the rewrite removes error handling or logging. The route is worse afterwards, so
 *   the score must not rise either, for a different and simpler reason.
 *
 * Within `preserving` there are two directions, and for a long time the corpus only had one of
 * them. A subtractive rewrite takes real signal away or moves it about: delete the catches, wrap
 * the body, merge the statements. An ADDITIVE rewrite puts fake signal in: a classifying catch over
 * a try that cannot throw, a test whose two arms are the same, a rethrow that can never run. The
 * additive direction is the one someone reaches for when a CI comment nags them, and it is where
 * the two largest holes ever found here lived. `ADDITIVE_IDS` lists the entries that cover it, and
 * `mutationCorpus.test.ts` asserts the class is not empty so it cannot quietly go away again.
 *
 * Neither kind is ever executed. "Semantics-preserving" here means preserving the observable
 * behaviour of the route as written, which is what the scanner claims to measure; it is not a
 * claim that the mutated tree compiles against its real types.
 */

export type MutationKind = "preserving" | "deleting";

/**
 * The result of rewriting one file: the new source, and how many places in it the rewrite actually
 * landed. `sites` is what the corpus's anti-vacuity guard reads. A file count says nothing about
 * whether the rewrite reached anything, and a mutation that quietly matched two constructs in a
 * file would otherwise look identical to one that matched forty.
 */
export type MutationResult = { source: string; sites: number };

export type Mutation = {
  id: string;
  kind: MutationKind;
  /** What the rewrite does, in one line, for the corpus table in the report. */
  what: string;
  /**
   * Set only on a `preserving` entry that is EXPECTED to lower some routes' scores, with the
   * one-line reason on the entry itself. The mirror assertion in `mutationCorpus.test.ts` requires
   * falls to be empty for every preserving entry without this field, and for an entry with it,
   * requires falls to be nonzero and every fall to be exactly `error-classification` moving pass
   * to not-applicable with nothing moving to fail. Deliberately a per-entry field rather than a
   * set or a skip list: an exemption is a decision with a reason, enforced in both directions, and
   * it must not be a place entries get filed so the suite stays green.
   */
  lowers?: string;
  /** The mutated file, or null when this file has nothing for the mutation to touch. */
  apply(fileName: string, source: string): MutationResult | null;
};

type Edit = { start: number; end: number; text: string };

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/**
 * Splice edits into `source`, right to left so earlier offsets stay valid.
 *
 * An edit that falls inside an earlier edit's range is dropped rather than applied: a mutation that
 * deletes a catch clause and one that rewrites a statement inside that clause would otherwise
 * produce overlapping splices. Dropping the inner one is what "the outer rewrite won" means.
 */
function applyEdits(source: string, edits: Edit[]): MutationResult | null {
  if (edits.length === 0) return null;
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: Edit[] = [];
  for (const edit of sorted) {
    const last = kept[kept.length - 1];
    if (last && edit.start < last.end) continue;
    kept.push(edit);
  }
  let out = source;
  for (let i = kept.length - 1; i >= 0; i--) {
    const edit = kept[i]!;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out === source ? null : { source: out, sites: kept.length };
}

function insert(at: number, text: string): Edit {
  return { start: at, end: at, text };
}

function forEachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    forEachNode(child, visit);
  });
}

// -- entry points ---------------------------------------------------------------------------

type EntryFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isEntryFunction(node: ts.Node): node is EntryFunction {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  );
}

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

function propertyNameOf(property: ts.ObjectLiteralElementLike): string | null {
  if (!property.name) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return null;
}

/**
 * Handler functions on a builder's object argument, in the two shapes the route builders use:
 * `handler` at the top level and `methods.POST.handler`.
 *
 * Deliberately a copy of the same shapes `src/scan.ts` recognises rather than an import of them.
 * The harness has to be able to disagree with the scanner about where a route body is; sharing the
 * scanner's own notion would let a bug in that notion hide a laundering shape from the corpus.
 */
function collectNamedHandlers(object: ts.ObjectLiteralExpression, out: EntryFunction[]): void {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameOf(property);
    const value = unwrap(property.initializer);
    if (name === "handler" && isEntryFunction(value)) out.push(value);
    if (name === "methods" && ts.isObjectLiteralExpression(value)) {
      for (const method of value.properties) {
        if (!ts.isPropertyAssignment(method)) continue;
        const config = unwrap(method.initializer);
        if (ts.isObjectLiteralExpression(config)) collectNamedHandlers(config, out);
      }
    }
  }
}

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
 * The handler functions an export's initializer resolves to.
 *
 * `locals` is consulted for the two indirect spellings, both of which `scan.ts` resolves and
 * neither of which this reached: `export const action = route.action` beside
 * `const route = createActionApiRoute(...)`, which is 7 of the tree's API routes, and
 * `export const action = handleThing` naming a local. `seen` stops `const a = b; const b = a`.
 */
function fromInitializer(
  expr: ts.Expression,
  out: EntryFunction[],
  locals: LocalDeclarations,
  seen: Set<string> = new Set()
): void {
  const target = unwrap(expr);
  if (isEntryFunction(target)) {
    out.push(target);
    return;
  }
  if (ts.isCallExpression(target)) {
    for (const arg of rootCall(target).arguments) {
      const unwrapped = unwrap(arg);
      if (isEntryFunction(unwrapped)) out.push(unwrapped);
      else if (ts.isObjectLiteralExpression(unwrapped)) collectNamedHandlers(unwrapped, out);
    }
    return;
  }
  // `route.action`, and any longer chain, is resolved from whatever declared its root identifier.
  let root: ts.Expression = target;
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
    root = unwrap(root.expression);
  }
  if (!ts.isIdentifier(root) || seen.has(root.text)) return;
  const declaration = locals.get(root.text);
  if (declaration === undefined) return;
  seen.add(root.text);
  if (ts.isFunctionDeclaration(declaration)) out.push(declaration);
  else fromInitializer(declaration, out, locals, seen);
}

const ENTRY_NAMES = new Set(["loader", "action"]);

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

/**
 * Top-level declarations by binding name, so a named export clause (`export { action }`) resolves
 * back to the initializer it came from. Object binding patterns are read element by element, which
 * is what makes `const { action, loader } = createActionApiRoute(...)` resolvable.
 */
type LocalDeclarations = Map<string, ts.Expression | ts.FunctionDeclaration>;

function localDeclarations(sf: ts.SourceFile): LocalDeclarations {
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
 * Block bodies of the exported `loader`/`action` handlers, the region a whole-body wrapper wraps.
 *
 * Reads the same four export forms `scan.ts` reads: an exported function declaration, an exported
 * `const`, an exported object binding pattern, and a named export clause resolved back through a
 * local. It read only the first two, which is the shape of every API route in the tree
 * (`const { action, loader } = createActionApiRoute(...); export { action, loader };` and the
 * direct `export const { action } = ...`), so `wrapEveryBody` and the other whole-body entries
 * silently skipped 36 of the 427 entry points while reporting a file count that suggested
 * otherwise. `mutationCorpus.test.ts` pins the population now ("wraps a body in every
 * non-delegating entry point the scanner finds"), so the harness cannot lag the scanner here again
 * without going red.
 *
 * This is NOT a retreat from the deliberate independence `collectNamedHandlers` documents. That
 * independence is about disagreeing over where a HANDLER sits inside a builder's argument, which is
 * a judgement the corpus has to be able to make for itself. Which exports exist is not a judgement,
 * and the harness was simply behind.
 */
function entryBodies(sf: ts.SourceFile): ts.Block[] {
  const functions: EntryFunction[] = [];
  const locals = localDeclarations(sf);
  const fromLocal = (name: string) => {
    const decl = locals.get(name);
    if (decl === undefined) return;
    if (ts.isFunctionDeclaration(decl)) functions.push(decl);
    else fromInitializer(decl, functions, locals);
  };

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      if (ENTRY_NAMES.has(statement.name.text)) functions.push(statement);
      continue;
    }

    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!decl.initializer) continue;
        if (ts.isIdentifier(decl.name)) {
          if (ENTRY_NAMES.has(decl.name.text)) fromInitializer(decl.initializer, functions, locals);
          continue;
        }
        if (!ts.isObjectBindingPattern(decl.name)) continue;
        for (const element of decl.name.elements) {
          if (ts.isIdentifier(element.name) && ENTRY_NAMES.has(element.name.text)) {
            fromInitializer(decl.initializer, functions, locals);
          }
        }
      }
      continue;
    }

    // A re-export (`export { loader } from "./x"`) has no local binding to resolve, and a namespace
    // clause cannot name a loader or an action.
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      !statement.moduleSpecifier &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (!ENTRY_NAMES.has(element.name.text)) continue;
        fromLocal(element.propertyName?.text ?? element.name.text);
      }
    }
  }

  // One handler can serve both exports, and both reach it by their own road: the loader and the
  // action of `const { loader, action } = createActionApiRoute({ handler })` resolve to the same
  // node. Wrapping it twice would splice the same text in twice at the same offset, because
  // `applyEdits` treats two zero-width inserts at one position as non-overlapping.
  const bodies: ts.Block[] = [];
  for (const fn of new Set(functions)) {
    if (fn.body && ts.isBlock(fn.body)) bodies.push(fn.body);
  }
  return bodies;
}

// -- generic mutation shapes ----------------------------------------------------------------

function catchClauses(sf: ts.SourceFile): ts.CatchClause[] {
  const out: ts.CatchClause[] = [];
  forEachNode(sf, (node) => {
    if (ts.isCatchClause(node)) out.push(node);
  });
  return out;
}

function bindingNameOf(clause: ts.CatchClause): string | null {
  const decl = clause.variableDeclaration;
  return decl && ts.isIdentifier(decl.name) ? decl.name.text : null;
}

/**
 * Splice a statement in at the HEAD of every catch clause that names its binding. `snippet`
 * receives the binding name.
 *
 * The head, not the tail, and that is the whole point of the helper. Appending put the shape after
 * whatever the clause already did, and 234 of the tree's 260 clauses end in a `return` or a
 * `throw`, so in those the spliced shape was dead by ordering before the rule under test ever
 * looked at it: eleven corpus entries reported touching 172 files while exercising 26 clauses. At
 * the head every clause is reachable, so every clause exercises the rule. The shapes spliced this
 * way are dead wherever they sit, so moving them does not make the rewrite any less preserving.
 */
function prependToEveryCatch(
  id: string,
  kind: MutationKind,
  what: string,
  snippet: (binding: string) => string
): Mutation {
  return {
    id,
    kind,
    what,
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      for (const clause of catchClauses(sf)) {
        const binding = bindingNameOf(clause);
        if (binding === null) continue;
        edits.push(insert(clause.block.getStart() + 1, `\n${snippet(binding)}\n`));
      }
      return applyEdits(source, edits);
    },
  };
}

/** Whether a statement list ends in a way that makes anything spliced in after it dead. Used only
 * to keep the dead-throw mutations honest: appending `throw e;` after statements that might fall
 * through would change what the route does, and this corpus is not allowed to do that. */
function endsInAnExit(statements: readonly ts.Statement[]): boolean {
  const last = statements[statements.length - 1];
  return last !== undefined && (ts.isReturnStatement(last) || ts.isThrowStatement(last));
}

/** Whether the tree rooted at `node` contains a `break` or `continue` outside a nested function or
 * a loop of its own. Wrapping such statements in a `do` or a `switch` would rebind them. */
function containsLooseJump(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isFunctionLike(n)) return;
    if (
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n) ||
      ts.isSwitchStatement(n)
    ) {
      return;
    }
    if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) found = true;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/**
 * Wrap every catch clause's body in a construct that definitely exits, then write `throw e;` after
 * it. The throw can never run, and before `definitelyExits` learned to see through the wrapper each
 * of these read as the clause rethrowing, which is `not-applicable` instead of `fail` and worth 50
 * points a route.
 *
 * Only applied to a clause whose statements already end in a `return` or a `throw`, so the appended
 * throw really is unreachable, and never to one holding a loose `break` or `continue`, which a `do`
 * or a `switch` would capture.
 *
 * `dead-throw-after-switch-break` guards the opposite direction of the same rule. A `break` in a
 * switch clause is no longer read as leaving the statement list the switch sits in, and the cheap
 * way to write that is "a clause holding a break does not exit", which would take this whole family
 * back: the clause here returns AND breaks, and the return is what has to win.
 */
function deadThrowAfter(id: string, what: string, wrap: (body: string) => string): Mutation {
  return {
    id,
    kind: "preserving",
    what,
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      for (const clause of catchClauses(sf)) {
        const binding = bindingNameOf(clause);
        if (binding === null) continue;
        const statements = clause.block.statements;
        if (statements.length === 0 || !endsInAnExit(statements)) continue;
        if (containsLooseJump(clause.block)) continue;
        const first = statements[0]!.getStart();
        const last = statements[statements.length - 1]!.end;
        const body = source.slice(first, last);
        edits.push({ start: first, end: last, text: `${wrap(body)}\nthrow ${binding};` });
      }
      return applyEdits(source, edits);
    },
  };
}

/** Wrap every route body in a single-shot wrapper, `open` before its statements and `close` after. */
function wrapEveryBody(
  id: string,
  what: string,
  open: string,
  close: string,
  lowers?: string
): Mutation {
  return {
    id,
    kind: "preserving",
    what,
    ...(lowers === undefined ? {} : { lowers }),
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      for (const body of entryBodies(sf)) {
        edits.push(insert(body.getStart() + 1, `\n${open}\n`));
        edits.push(insert(body.end - 1, `\n${close}\n`));
      }
      return applyEdits(source, edits);
    },
  };
}

/** Prepend text at the very top of every file, before the first token's leading trivia. */
function prependToEveryFile(id: string, what: string, text: string): Mutation {
  return {
    id,
    kind: "preserving",
    what,
    apply(_fileName, source) {
      return { source: `${text}\n${source}`, sites: 1 };
    },
  };
}

const LOGGER_CALLEE = /(^|\.)(logger|log)\.[A-Za-z_$][\w$]*$/;

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

function logStatementEdits(sf: ts.SourceFile): Edit[] {
  const edits: Edit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isExpressionStatement(node)) return;
    const call = unwrap(node.expression);
    if (!ts.isCallExpression(call)) return;
    const text = calleeText(call.expression);
    if (text !== null && LOGGER_CALLEE.test(text)) {
      edits.push({ start: node.getStart(), end: node.end, text: ";" });
    }
  });
  return edits;
}

/**
 * Remove the catch clause from every `try`. With a `finally` present the clause alone goes and the
 * `try`/`finally` stands; without one the whole `try` collapses to the bare block it guarded, which
 * is still a legal statement. Point edits either way, so a nested rewrite inside the clause is
 * simply dropped by `applyEdits` rather than colliding.
 */
function catchDeletionEdits(sf: ts.SourceFile): Edit[] {
  const edits: Edit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isTryStatement(node) || !node.catchClause) return;
    if (node.finallyBlock) {
      edits.push({ start: node.catchClause.getStart(), end: node.catchClause.end, text: " " });
      return;
    }
    edits.push({ start: node.getStart(), end: node.tryBlock.getStart(), text: "" });
    edits.push({ start: node.tryBlock.end, end: node.end, text: "" });
  });
  return edits;
}

// -- the corpus -------------------------------------------------------------------------------

/**
 * Every laundering shape found by a reviewer on this branch, plus the five extra dead-code shapes
 * and two extra iteration receivers found while writing this file. Each entry is a whole-tree
 * rewrite; `mutationCorpus.test.ts` asserts the global score does not rise for any of them.
 */
export const MUTATIONS: Mutation[] = [
  prependToEveryFile(
    "suppress-every-check",
    "prepend an obs-map-disable directive for every check to every file",
    // Every check, which this said it was and was not: `auth-scope` was added a round after the
    // entry was written and never added here, so the "a suppression cannot raise a score"
    // invariant went untested at tree scale for the 19 routes it applies to.
    [
      "// obs-map-disable error-classification -- mutation corpus",
      "// obs-map-disable request-context -- mutation corpus",
      "// obs-map-disable auth-boundary -- mutation corpus",
      "// obs-map-disable auth-scope -- mutation corpus",
      "// obs-map-disable audit-trail -- mutation corpus",
    ].join("\n")
  ),

  {
    id: "jsx-text-line-directive",
    kind: "preserving",
    what: "add a component whose JSX text begins with a // directive",
    apply(fileName, source) {
      if (!fileName.endsWith(".tsx")) return null;
      return {
        source: `${source}\nexport function ObsMapMutationA() {\n  return <p>// obs-map-disable error-classification -- mutation corpus</p>;\n}\n`,
        sites: 1,
      };
    },
  },
  {
    id: "jsx-text-after-expression",
    kind: "preserving",
    what: "add a component whose JSX text starts a // directive right after an expression container",
    apply(fileName, source) {
      if (!fileName.endsWith(".tsx")) return null;
      return {
        source: `${source}\nexport function ObsMapMutationB({ name }: { name: string }) {\n  return <p>{name}// obs-map-disable request-context -- mutation corpus</p>;\n}\n`,
        sites: 1,
      };
    },
  },
  {
    id: "jsx-text-block-directive",
    kind: "preserving",
    what: "add a component whose JSX text is a /* */ directive",
    apply(fileName, source) {
      if (!fileName.endsWith(".tsx")) return null;
      return {
        source: `${source}\nexport function ObsMapMutationC() {\n  return <p>/* obs-map-disable audit-trail -- mutation corpus */</p>;\n}\n`,
        sites: 1,
      };
    },
  },

  {
    id: "delete-every-catch",
    kind: "deleting",
    what: "remove every catch clause",
    apply(fileName, source) {
      return applyEdits(source, catchDeletionEdits(parse(fileName, source)));
    },
  },
  {
    id: "delete-every-log",
    kind: "deleting",
    what: "remove every logger call statement",
    apply(fileName, source) {
      return applyEdits(source, logStatementEdits(parse(fileName, source)));
    },
  },
  {
    id: "delete-every-catch-and-log",
    kind: "deleting",
    what: "remove every catch clause and every logger call statement",
    apply(fileName, source) {
      const sf = parse(fileName, source);
      return applyEdits(source, [...catchDeletionEdits(sf), ...logStatementEdits(sf)]);
    },
  },

  wrapEveryBody(
    "wrap-body-in-rethrow",
    "wrap every route body in try { ... } catch (e) { throw e }",
    "try {",
    "} catch (obsMapMutationError) { throw obsMapMutationError; }"
  ),
  // The A/B partner of the entry above: the only difference is the ternary. `error-classification`
  // asks whether ANY reachable catch decides, so one deciding clause bought at zero cost would take
  // every route in the tree to a pass. That is what the same-arms rule in `selectsAnErrorPath`
  // refuses, and this is the tree-scale proof of it on the throw path, which was untested while
  // the throw path could not credit a ternary at all.
  wrapEveryBody(
    "wrap-body-in-same-arms-throw-ternary",
    "wrap every route body in try { ... } catch (e) { throw e instanceof Error ? e : e }",
    "try {",
    "} catch (obsMapMutationError) { throw obsMapMutationError instanceof Error " +
      "? obsMapMutationError : obsMapMutationError; }"
  ),
  wrapEveryBody(
    "wrap-body-in-trace",
    'wrap every route body in trace("x", async () => { ... })',
    'return obsMapTrace("obs-map-mutation", async () => {',
    "});"
  ),
  wrapEveryBody(
    "wrap-body-in-single-element-map",
    "wrap every route body in Promise.all([0].map(async () => { ... }))",
    "return Promise.all([0].map(async () => {",
    "})).then((obsMapResults) => obsMapResults[0]);"
  ),
  wrapEveryBody(
    "wrap-body-in-single-element-flatmap",
    "wrap every route body in Promise.all([0].flatMap(async () => { ... }))",
    "return Promise.all([0].flatMap(async () => {",
    "})).then((obsMapResults) => obsMapResults[0]);"
  ),
  wrapEveryBody(
    "wrap-body-in-non-array-map",
    "wrap every route body in a non-array receiver's .map(...)",
    "return obsMapResult.map(async () => {",
    "});",
    "moves every catch behind the iteration boundary; refused deciding catches cap at " +
      "not-applicable, so a pass legitimately becomes n/a (mechanism C ruling)"
  ),
  // Round D item 3. `auth-scope` fired on any property at all whose value was a caller id, wherever
  // it sat, so one dead statement at the head of a body cleared it. These are the two halves: the
  // wrong property name, and the right property name in an object nothing is handed. Both raised
  // `settings.sso` and `settings.team`, the only two findings the check has ever produced.
  wrapEveryBody(
    "dead-caller-scope-object",
    "prepend a dead object holding the caller id under an arbitrary key to every route body",
    "const obsMapDeadScope = { anything: user.id };",
    ""
  ),
  wrapEveryBody(
    "dead-caller-scope-userid",
    "prepend a dead object holding the caller id under userId to every route body",
    "const obsMapDeadUserId = { userId: user.id };",
    ""
  ),
  // Round E item 3. The two entries above both prepend a DEAD object, which the handed-to-a-call
  // condition refuses on its own, so neither of them would notice a future edit widening that
  // condition. This one is live: the object really is handed to a real call, and the only thing
  // refusing it is the callee constraint. It is also the cheaper shape to write, since a log line
  // survives review in a way `const obsMapDeadUserId = ...` does not.
  wrapEveryBody(
    "log-caller-scope-userid",
    "prepend a logger call handed the caller id under userId to every route body",
    'logger.error("obs-map", { userId: user.id });',
    ""
  ),
  // C1a. `auth-boundary` matched `/^(require|authenticate)/`, so any callee at all beginning
  // `require` cleared a sensitive route. These two prepend the shapes that paid: an invented guard
  // and a real helper whose name merely contains "Authenticated" while it does a lookup by id.
  wrapEveryBody(
    "fake-require-guard",
    "prepend an invented requireObsMapValidRequest() call to every route body",
    "requireObsMapValidRequest();",
    ""
  ),
  wrapEveryBody(
    "fake-authenticated-lookup",
    "prepend a resolveAuthenticatedEnv() call to every route body",
    "resolveAuthenticatedEnv();",
    ""
  ),
  wrapEveryBody(
    "wrap-body-in-non-array-filter",
    "wrap every route body in a non-array receiver's .filter(...)",
    "return obsMapPipe.filter(async () => {",
    "});",
    "moves every catch behind the iteration boundary; refused deciding catches cap at " +
      "not-applicable, so a pass legitimately becomes n/a (mechanism C ruling)"
  ),

  {
    id: "throw-after-return-in-catch",
    kind: "preserving",
    what: "splice throw e; after the first return in every catch",
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      for (const clause of catchClauses(sf)) {
        const binding = bindingNameOf(clause);
        if (binding === null) continue;
        const returned = clause.block.statements.find(ts.isReturnStatement);
        if (!returned) continue;
        edits.push(insert(returned.end, ` throw ${binding};`));
      }
      return applyEdits(source, edits);
    },
  },

  prependToEveryCatch(
    "dead-if-false",
    "preserving",
    "splice if (false) { throw e; } into every catch",
    (e) => `if (false) { throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-while-false",
    "preserving",
    "splice while (false) { throw e; } into every catch",
    (e) => `while (false) { throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-for-false",
    "preserving",
    "splice for (;false;) { throw e; } into every catch",
    (e) => `for (;false;) { throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-if-true-else",
    "preserving",
    "splice if (true) { 0; } else { throw e; } into every catch",
    (e) => `if (true) { 0; } else { throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-switch-no-case",
    "preserving",
    "splice switch (1) { case 2: throw e; } into every catch",
    (e) => `switch (1) { case 2: throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-inner-try",
    "preserving",
    "splice try { 0; } catch { throw e; } into every catch",
    (e) => `try { 0; } catch { throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-for-of-empty",
    "preserving",
    "splice for (const x of []) { throw e; } into every catch",
    (e) => `for (const obsMapItem of []) { throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-for-in-empty",
    "preserving",
    "splice for (const k in {}) { throw e; } into every catch",
    (e) => `for (const obsMapKey in {}) { throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-if-empty-string",
    "preserving",
    'splice if ("") { throw e; } into every catch',
    (e) => `if ("") { throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-if-not-true",
    "preserving",
    "splice if (!true) { throw e; } into every catch",
    (e) => `if (!true) { throw ${e}; }`
  ),
  prependToEveryCatch(
    "dead-if-const-compare",
    "preserving",
    "splice if (1 === 2) { throw e; } into every catch",
    (e) => `if (1 === 2) { throw ${e}; }`
  ),
  // The returns half of the dead-prepend family. The eleven entries above put a dead THROW in;
  // this one puts a dead RETURN in, which used to veto `rethrows` through the containment read
  // and turn a rethrow-only clause into a swallow verdict on 11 real routes. Same blinding class
  // as `dead-if-false`, so like that entry it is not additive: it fakes no signal, it used to
  // destroy real signal.
  prependToEveryCatch(
    "dead-if-false-return",
    "preserving",
    "splice if (false) { return null; } into every catch",
    () => `if (false) { return null; }`
  ),
  prependToEveryCatch(
    "registered-throw",
    "preserving",
    "splice [].push(() => { throw e; }) into every catch",
    (e) => `[].push(() => { throw ${e}; });`
  ),
  prependToEveryCatch(
    "empty-instanceof-if",
    "preserving",
    "splice if (e instanceof Error) { } into every catch",
    (e) => `if (${e} instanceof Error) { }`
  ),
  // The if/else arm walk merges per-arm evidence by INTERSECTION, so a real classifier sitting in
  // one arm only earns nothing: one arm running is a condition, not a guarantee. This is the entry
  // that goes red the day someone "simplifies" the intersection to a union, at which point every
  // clause in the tree earns a branch from a dead arm. Additive: it plants fake signal.
  prependToEveryCatch(
    "dead-classifier-one-arm",
    "preserving",
    "splice a dead one-arm classifier if/else into every catch",
    (e) =>
      `if (false) { if (${e} instanceof Error) { return new Response(null, { status: 400 }); } } else { 0; }`
  ),
  // A finally that leaves itself by `break` cancels the try's completion, so nothing hosted in
  // that tryBlock ever escapes the clause: the whole statement is a no-op. The walk's
  // catchless-try entry credited it anyway, minting a branch from the hosted classifier on 80
  // routes and 8 global points when measured. Additive: it plants fake signal. The classifier is
  // guarded (`if (e instanceof Error)`) rather than a bare `throw e` so `definitelyExits` cannot
  // read the statement as an unconditional exit; the bare spelling trips a separate, pre-existing
  // over-cut in `definitelyExits`'s try/finally case that this entry is not about.
  prependToEveryCatch(
    "dead-throw-in-cancelled-try",
    "preserving",
    "splice a finally-break try that discards its own throw into every catch",
    (e) =>
      `do { try { if (${e} instanceof Error) { throw ${e}; } } finally { break; } } while (false);`
  ),

  // The additive class. Everything above either takes signal away or moves it about; these put in
  // signal that is not real, which is the direction the corpus was blind to.
  {
    id: "dead-classifying-try",
    kind: "preserving",
    what: "prepend a classifying try/catch over a try block that cannot throw",
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      for (const body of entryBodies(sf)) {
        edits.push(
          insert(
            body.getStart() + 1,
            "\ntry { 0; } catch (obsMapDead) {" +
              " if (obsMapDead instanceof Error) { return new Response(null, { status: 400 }); }" +
              " throw obsMapDead; }\n"
          )
        );
      }
      return applyEdits(source, edits);
    },
  },
  {
    id: "dead-classifying-try-with-call",
    kind: "preserving",
    what: "prepend a classifying try/catch over a try block whose only work is an inert call",
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      for (const body of entryBodies(sf)) {
        edits.push(
          insert(
            body.getStart() + 1,
            "\ntry { String(0); } catch (obsMapDead) {" +
              " if (obsMapDead instanceof Error) { return new Response(null, { status: 400 }); }" +
              " throw obsMapDead; }\n"
          )
        );
      }
      return applyEdits(source, edits);
    },
  },
  {
    id: "same-arms-ternary",
    kind: "preserving",
    what: "rewrite a catch's return value as a ternary on the error with identical arms",
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      for (const clause of catchClauses(sf)) {
        const binding = bindingNameOf(clause);
        if (binding === null) continue;
        for (const statement of clause.block.statements) {
          if (!ts.isReturnStatement(statement) || !statement.expression) continue;
          const value = source.slice(statement.expression.getStart(), statement.expression.end);
          edits.push({
            start: statement.expression.getStart(),
            end: statement.expression.end,
            text: `${binding} instanceof Error ? (${value}) : (${value})`,
          });
        }
      }
      return applyEdits(source, edits);
    },
  },
  deadThrowAfter(
    "dead-throw-after-block",
    "wrap every catch body in a bare block and write throw e; after it",
    (body) => `{\n${body}\n}`
  ),
  deadThrowAfter(
    "dead-throw-after-do",
    "wrap every catch body in do { ... } while (false) and write throw e; after it",
    (body) => `do {\n${body}\n} while (false);`
  ),
  deadThrowAfter(
    "dead-throw-after-if-true",
    "wrap every catch body in if (true) { ... } and write throw e; after it",
    (body) => `if (true) {\n${body}\n}`
  ),
  deadThrowAfter(
    "dead-throw-after-if-else",
    "wrap every catch body in both arms of an if/else and write throw e; after it",
    (body) => `if (obsMapPick()) {\n${body}\n} else {\n${body}\n}`
  ),
  deadThrowAfter(
    "dead-throw-after-switch",
    "wrap every catch body in a switch default and write throw e; after it",
    (body) => `switch (1) { default: {\n${body}\n} }`
  ),
  deadThrowAfter(
    "dead-throw-after-switch-break",
    "wrap every catch body in a switch default that also breaks and write throw e; after it",
    (body) => `switch (1) { default: {\n${body}\n}\nbreak; }`
  ),
  deadThrowAfter(
    "dead-throw-after-try-finally",
    "wrap every catch body in try { ... } finally { } and write throw e; after it",
    (body) => `try {\n${body}\n} finally { }`
  ),
  {
    id: "dead-branch-after-if-true",
    kind: "preserving",
    what: "wrap every catch body in if (true) { ... } and write a dead error test after it",
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      for (const clause of catchClauses(sf)) {
        const binding = bindingNameOf(clause);
        if (binding === null) continue;
        const statements = clause.block.statements;
        if (statements.length === 0 || !endsInAnExit(statements)) continue;
        if (containsLooseJump(clause.block)) continue;
        const first = statements[0]!.getStart();
        const last = statements[statements.length - 1]!.end;
        const body = source.slice(first, last);
        edits.push({
          start: first,
          end: last,
          text:
            `if (true) {\n${body}\n}\n` +
            `if (${binding} instanceof Error) { return new Response(null, { status: 400 }); }`,
        });
      }
      return applyEdits(source, edits);
    },
  },

  // The no-pass ceiling on refused (iteration-callback) catches, at tree scale. A two-element
  // array literal iterates, so the boundary rule refuses this catch; it decides and cannot run
  // its deciding arm (JSON.parse("0") never throws). Under any future rule that CREDITS refused
  // catches, the ~261 catchless routes rise from not-applicable to pass and this entry goes red.
  wrapEveryBody(
    "dead-deciding-map",
    "prepend a dead deciding per-item catch inside a two-element .map to every route body",
    '[0, 1].map((obsMapV) => { try { JSON.parse("0"); } catch (obsMapDead) {' +
      " if (obsMapDead instanceof SyntaxError) { return null; } throw obsMapDead; }" +
      " return obsMapV; });",
    ""
  ),

  {
    id: "merge-declarations",
    kind: "preserving",
    what: "merge adjacent const statements into one declaration list",
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      forEachNode(sf, (node) => {
        if (!ts.isBlock(node)) return;
        const statements = node.statements;
        for (let i = 1; i < statements.length; i++) {
          const previous = statements[i - 1]!;
          const current = statements[i]!;
          if (!isSingleConst(previous) || !isSingleConst(current)) continue;
          if (source[previous.end - 1] !== ";") continue;
          const declaration = current.declarationList.declarations[0]!;
          edits.push({ start: previous.end - 1, end: declaration.getStart(), text: ", " });
        }
      });
      return applyEdits(source, edits);
    },
  },

  {
    id: "merge-comma-expressions",
    kind: "preserving",
    what: "merge adjacent expression statements into one comma expression",
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      forEachNode(sf, (node) => {
        if (!ts.isBlock(node) && !ts.isSourceFile(node)) return;
        const statements = node.statements;
        for (let i = 1; i < statements.length; i++) {
          const previous = statements[i - 1]!;
          const current = statements[i]!;
          if (!ts.isExpressionStatement(previous) || !ts.isExpressionStatement(current)) continue;
          // A directive prologue is an ExpressionStatement, and `"use client", foo();` is no longer
          // a directive. That is a behaviour change, which this entry claims not to make.
          if (ts.isStringLiteral(previous.expression)) continue;
          if (source[previous.end - 1] !== ";") continue;
          edits.push({ start: previous.end - 1, end: current.getStart(), text: ", " });
        }
      });
      return applyEdits(source, edits);
    },
  },

  {
    id: "inert-statements-after-try",
    kind: "preserving",
    what: "splice five unused const declarations after every try statement in a route body",
    apply(fileName, source) {
      const sf = parse(fileName, source);
      const edits: Edit[] = [];
      let n = 0;
      for (const body of entryBodies(sf)) {
        forEachNode(body, (node) => {
          if (!ts.isTryStatement(node)) return;
          if (!node.parent || !ts.isBlock(node.parent)) return;
          const filler = Array.from({ length: 5 }, () => `const obsMapInert${n++} = 1;`).join(" ");
          edits.push(insert(node.end, `\n${filler}\n`));
        });
      }
      return applyEdits(source, edits);
    },
  },
];

/**
 * The entries that add fake signal rather than removing or restructuring real signal. Named so
 * `mutationCorpus.test.ts` can assert the class exists: the corpus went three rounds with this half
 * of the property untested, and an empty list here is exactly that state coming back.
 */
export const ADDITIVE_IDS = [
  "dead-classifying-try",
  "dead-classifying-try-with-call",
  "same-arms-ternary",
  "dead-throw-after-block",
  "dead-throw-after-do",
  "dead-throw-after-if-true",
  "dead-throw-after-if-else",
  "dead-throw-after-switch",
  "dead-throw-after-switch-break",
  "dead-throw-after-try-finally",
  "wrap-body-in-rethrow",
  "wrap-body-in-same-arms-throw-ternary",
  "empty-instanceof-if",
  "dead-classifier-one-arm",
  "dead-throw-in-cancelled-try",
  "dead-deciding-map",
  "registered-throw",
  "fake-require-guard",
  "fake-authenticated-lookup",
  "dead-caller-scope-object",
  "dead-caller-scope-userid",
  "log-caller-scope-userid",
];

function isSingleConst(statement: ts.Statement): statement is ts.VariableStatement {
  return (
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    statement.declarationList.declarations.length === 1 &&
    statement.declarationList.declarations[0]!.initializer !== undefined
  );
}
