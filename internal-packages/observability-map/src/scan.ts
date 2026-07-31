import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryPoint } from "./types.js";

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

export function scanFile(fileName: string, source: string): EntryPoint | null {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  const ep: EntryPoint = {
    fileName,
    source,
    hasLoader: false,
    hasAction: false,
    loaderInitializerCallee: null,
    actionInitializerCallee: null,
    importedNames: [],
    calleeNames: [],
    hasTryCatch: false,
    statementCount: 0,
  };

  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) ep.importedNames.push(el.name.text);
      }
      if (node.importClause.name) ep.importedNames.push(node.importClause.name.text);
    }

    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText(sf);
        if (name !== "loader" && name !== "action") continue;
        if (name === "loader") ep.hasLoader = true;
        if (name === "action") ep.hasAction = true;
        let init = decl.initializer;
        if (init && ts.isPropertyAccessExpression(init)) init = init.expression;
        if (init && ts.isCallExpression(init)) {
          const cn = calleeName(init.expression);
          if (name === "loader") ep.loaderInitializerCallee = cn;
          else ep.actionInitializerCallee = cn;
        }
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      if (node.name.text === "loader") ep.hasLoader = true;
      if (node.name.text === "action") ep.hasAction = true;
      if (node.body) ep.statementCount += node.body.statements.length;
    }

    if (ts.isTryStatement(node)) ep.hasTryCatch = true;

    if (ts.isCallExpression(node)) {
      const cn = calleeName(node.expression);
      if (cn) ep.calleeNames.push(cn);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  if (!ep.hasLoader && !ep.hasAction) return null;
  if (ep.statementCount === 0) {
    ep.statementCount = countArrowBodyStatements(sf);
  }
  return ep;
}

function countArrowBodyStatements(sf: ts.SourceFile): number {
  let count = 0;
  const visit = (n: ts.Node) => {
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body)) {
      count += n.body.statements.length;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return count;
}

export function scanDirectory(dir: string): {
  entryPoints: EntryPoint[];
  parseFailures: string[];
} {
  const entryPoints: EntryPoint[] = [];
  const parseFailures: string[] = [];
  const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));

  for (const fileName of files) {
    try {
      const ep = scanFile(fileName, readFileSync(join(dir, fileName), "utf8"));
      if (ep) entryPoints.push(ep);
    } catch {
      parseFailures.push(fileName);
    }
  }
  return { entryPoints, parseFailures };
}
