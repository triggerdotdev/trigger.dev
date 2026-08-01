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
 * Neither kind is ever executed. "Semantics-preserving" here means preserving the observable
 * behaviour of the route as written, which is what the scanner claims to measure; it is not a
 * claim that the mutated tree compiles against its real types.
 */

export type MutationKind = "preserving" | "deleting";

export type Mutation = {
  id: string;
  kind: MutationKind;
  /** What the rewrite does, in one line, for the corpus table in the report. */
  what: string;
  /** The mutated source, or null when this file has nothing for the mutation to touch. */
  apply(fileName: string, source: string): string | null;
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
function applyEdits(source: string, edits: Edit[]): string | null {
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
  return out === source ? null : out;
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

function fromInitializer(expr: ts.Expression, out: EntryFunction[]): void {
  const target = unwrap(expr);
  if (isEntryFunction(target)) {
    out.push(target);
    return;
  }
  if (!ts.isCallExpression(target)) return;
  for (const arg of rootCall(target).arguments) {
    const unwrapped = unwrap(arg);
    if (isEntryFunction(unwrapped)) out.push(unwrapped);
    else if (ts.isObjectLiteralExpression(unwrapped)) collectNamedHandlers(unwrapped, out);
  }
}

const ENTRY_NAMES = new Set(["loader", "action"]);

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

/** Block bodies of the exported `loader`/`action` handlers, the region a whole-body wrapper wraps. */
function entryBodies(sf: ts.SourceFile): ts.Block[] {
  const functions: EntryFunction[] = [];
  for (const statement of sf.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (ENTRY_NAMES.has(statement.name.text)) functions.push(statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      if (ENTRY_NAMES.has(decl.name.text)) fromInitializer(decl.initializer, functions);
    }
  }
  const bodies: ts.Block[] = [];
  for (const fn of functions) {
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
 * Append a statement at the end of every catch clause that names its binding. `snippet` receives
 * the binding name. Appending is the position that matters: a shape spliced in after a `return` is
 * already unreachable and proves nothing.
 */
function appendToEveryCatch(
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
        edits.push(insert(clause.block.end - 1, `\n${snippet(binding)}\n`));
      }
      return applyEdits(source, edits);
    },
  };
}

/** Wrap every route body in a single-shot wrapper, `open` before its statements and `close` after. */
function wrapEveryBody(id: string, what: string, open: string, close: string): Mutation {
  return {
    id,
    kind: "preserving",
    what,
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
      return `${text}\n${source}`;
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
    [
      "// obs-map-disable error-classification -- mutation corpus",
      "// obs-map-disable request-context -- mutation corpus",
      "// obs-map-disable auth-boundary -- mutation corpus",
      "// obs-map-disable audit-trail -- mutation corpus",
    ].join("\n")
  ),

  {
    id: "jsx-text-line-directive",
    kind: "preserving",
    what: "add a component whose JSX text begins with a // directive",
    apply(fileName, source) {
      if (!fileName.endsWith(".tsx")) return null;
      return `${source}\nexport function ObsMapMutationA() {\n  return <p>// obs-map-disable error-classification -- mutation corpus</p>;\n}\n`;
    },
  },
  {
    id: "jsx-text-after-expression",
    kind: "preserving",
    what: "add a component whose JSX text starts a // directive right after an expression container",
    apply(fileName, source) {
      if (!fileName.endsWith(".tsx")) return null;
      return `${source}\nexport function ObsMapMutationB({ name }: { name: string }) {\n  return <p>{name}// obs-map-disable request-context -- mutation corpus</p>;\n}\n`;
    },
  },
  {
    id: "jsx-text-block-directive",
    kind: "preserving",
    what: "add a component whose JSX text is a /* */ directive",
    apply(fileName, source) {
      if (!fileName.endsWith(".tsx")) return null;
      return `${source}\nexport function ObsMapMutationC() {\n  return <p>/* obs-map-disable audit-trail -- mutation corpus */</p>;\n}\n`;
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
    "});"
  ),
  wrapEveryBody(
    "wrap-body-in-non-array-filter",
    "wrap every route body in a non-array receiver's .filter(...)",
    "return obsMapPipe.filter(async () => {",
    "});"
  ),

  {
    id: "throw-after-return-in-catch",
    kind: "preserving",
    what: "append throw e; after the first return in every catch",
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

  appendToEveryCatch(
    "dead-if-false",
    "preserving",
    "append if (false) { throw e; } to every catch",
    (e) => `if (false) { throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-while-false",
    "preserving",
    "append while (false) { throw e; } to every catch",
    (e) => `while (false) { throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-for-false",
    "preserving",
    "append for (;false;) { throw e; } to every catch",
    (e) => `for (;false;) { throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-if-true-else",
    "preserving",
    "append if (true) { 0; } else { throw e; } to every catch",
    (e) => `if (true) { 0; } else { throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-switch-no-case",
    "preserving",
    "append switch (1) { case 2: throw e; } to every catch",
    (e) => `switch (1) { case 2: throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-inner-try",
    "preserving",
    "append try { 0; } catch { throw e; } to every catch",
    (e) => `try { 0; } catch { throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-for-of-empty",
    "preserving",
    "append for (const x of []) { throw e; } to every catch",
    (e) => `for (const obsMapItem of []) { throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-for-in-empty",
    "preserving",
    "append for (const k in {}) { throw e; } to every catch",
    (e) => `for (const obsMapKey in {}) { throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-if-empty-string",
    "preserving",
    'append if ("") { throw e; } to every catch',
    (e) => `if ("") { throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-if-not-true",
    "preserving",
    "append if (!true) { throw e; } to every catch",
    (e) => `if (!true) { throw ${e}; }`
  ),
  appendToEveryCatch(
    "dead-if-const-compare",
    "preserving",
    "append if (1 === 2) { throw e; } to every catch",
    (e) => `if (1 === 2) { throw ${e}; }`
  ),
  appendToEveryCatch(
    "registered-throw",
    "preserving",
    "append [].push(() => { throw e; }) to every catch",
    (e) => `[].push(() => { throw ${e}; });`
  ),
  appendToEveryCatch(
    "empty-instanceof-if",
    "preserving",
    "append if (e instanceof Error) { } to every catch",
    (e) => `if (${e} instanceof Error) { }`
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
    what: "append five unused const declarations after every try statement in a route body",
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

function isSingleConst(statement: ts.Statement): statement is ts.VariableStatement {
  return (
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    statement.declarationList.declarations.length === 1 &&
    statement.declarationList.declarations[0]!.initializer !== undefined
  );
}
