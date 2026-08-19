import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The repo's `typescript` is the 7.x native port, which has no createSourceFile in JS.
import ts from "typescript-legacy-api";
import type {
  Expression,
  JsxElement,
  JsxSelfClosingElement,
  Node as TsNode,
} from "typescript-legacy-api";
import { describe, expect, it } from "vitest";

/**
 * Radix tooltip content never becomes the accessible name of its trigger, and a `TooltipTrigger`
 * without `asChild` renders its own `<button>` (nesting any interactive child, and dropping it from
 * the tab order unless `tabbable`). This scans the JSX for both mistakes so the next one is loud.
 */

const APP_DIR = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const WEBAPP_DIR = path.resolve(APP_DIR, "..");

const INTERACTIVE = new Set([
  "a",
  "button",
  "input",
  "Button",
  "DialogTrigger",
  "ExtLink",
  "Link",
  "LinkButton",
  "NavLinkButton",
  "PopoverMenuItem",
  "PopoverTrigger",
  "SelectTrigger",
  "SideMenuItemButton",
  "TextLink",
]);

/**
 * Sites that already violated this before the scan existed. Entries are `<file>::<tag>`; they were
 * not reviewed or fixed here. Removing an entry as you fix it is the point — never add one.
 */
const UNNAMED_BASELINE = new Set([
  "app/components/metrics/QueryWidget.tsx::Button",
  "app/components/navigation/EnvironmentSelector.tsx::PopoverTrigger",
  "app/components/navigation/NotificationPanel.tsx::PopoverTrigger",
  "app/components/navigation/SideMenu.tsx::PopoverTrigger",
  "app/components/primitives/DateTimePicker.tsx::button",
  "app/components/primitives/SearchInput.tsx::button",
  "app/components/runs/v3/AIFilterInput.tsx::button",
  "app/components/runs/v3/TaskRunsTable.tsx::DialogTrigger",
  "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.sessions.$sessionParam/route.tsx::TextLink",
  "app/routes/account.tokens/route.tsx::DialogTrigger",
  "app/routes/resources.incidents.tsx::PopoverTrigger",
  "app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route.tsx::TextLink",
]);

const NO_AS_CHILD_BASELINE = new Set([
  "app/components/GitMetadata.tsx::LinkButton",
  "app/components/code/TSQLResultsTable.tsx::TextLink",
  "app/components/integrations/VercelLink.tsx::LinkButton",
  "app/components/runs/v3/RunTag.tsx::Link",
  "app/components/runs/v3/TaskRunsTable.tsx::DialogTrigger",
  "app/routes/account.tokens/route.tsx::DialogTrigger",
  "app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route.tsx::TextLink",
]);

type Violation = { key: string; where: string; problems: string[] };

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

type JsxNode = JsxElement | JsxSelfClosingElement;

function tagOf(node: JsxNode): string {
  return (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText();
}

function attrOf(node: JsxNode, name: string) {
  const open = ts.isJsxElement(node) ? node.openingElement : node;
  return open.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
}

function hasStaticTrueAttribute(node: JsxNode, name: string): boolean {
  const attribute = attrOf(node, name);
  if (!attribute || !ts.isJsxAttribute(attribute)) return false;
  if (!attribute.initializer) return true;
  return (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword
  );
}

/** Text anywhere under the element, ignoring an expression that can render nothing. */
function hasText(node: TsNode): boolean {
  if (!ts.isJsxElement(node)) return false;
  return node.children.some((child) => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) return hasText(child);
    if (ts.isJsxText(child)) return child.getText().trim().length > 0;
    if (ts.isJsxExpression(child)) {
      const expression = child.expression;
      if (!expression) return false;
      if (ts.isConditionalExpression(expression)) {
        const empty = (x: TsNode) =>
          x.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(x) && x.text === "undefined") ||
          (ts.isStringLiteral(x) && x.text === "");
        return !empty(expression.whenTrue) && !empty(expression.whenFalse);
      }
      return true;
    }
    return false;
  });
}

function scanFile(file: string, relative: string): Violation[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  const locals = new Map<string, Expression>();
  const collectLocals = (node: TsNode) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      locals.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectLocals);
  };
  collectLocals(source);

  const resolve = (expression: Expression | undefined, seen = new Set<string>()): Expression[] => {
    if (!expression) return [];
    if (ts.isParenthesizedExpression(expression)) return resolve(expression.expression, seen);
    if (ts.isConditionalExpression(expression)) {
      return [...resolve(expression.whenTrue, seen), ...resolve(expression.whenFalse, seen)];
    }
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      seen.add(expression.text);
      return resolve(locals.get(expression.text), seen);
    }
    return [expression];
  };

  const triggersIn = (root: TsNode): JsxNode[] => {
    const found: JsxNode[] = [];
    const visited = new Set<TsNode>();
    const walk = (node: TsNode) => {
      if (visited.has(node)) return;
      visited.add(node);
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = tagOf(node);
        // Overlay panels render elsewhere in the DOM; their controls are not this trigger.
        if (tag.endsWith("Content")) return;
        if (INTERACTIVE.has(tag)) {
          found.push(node);
          return;
        }
      }
      // A wrapper's child may be a variable holding the real control.
      if (ts.isJsxExpression(node) && node.expression) {
        resolve(node.expression).forEach(walk);
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(root);
    return found;
  };

  const violations: Violation[] = [];
  const visit = (node: TsNode) => {
    if (
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
      tagOf(node) === "SimpleTooltip"
    ) {
      const buttonAttr = attrOf(node, "button");
      const initializer =
        buttonAttr && ts.isJsxAttribute(buttonAttr) ? buttonAttr.initializer : undefined;
      if (initializer && ts.isJsxExpression(initializer)) {
        const asChild = hasStaticTrueAttribute(node, "asChild");
        for (const trigger of resolve(initializer.expression).flatMap(triggersIn)) {
          const named =
            !!attrOf(trigger, "aria-label") ||
            !!attrOf(trigger, "aria-labelledby") ||
            !!attrOf(trigger, "title") ||
            hasText(trigger);
          const problems = [!named && "unnamed", !asChild && "no-asChild"].filter(
            (p): p is string => typeof p === "string"
          );
          if (problems.length) {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            violations.push({
              key: `${relative}::${tagOf(trigger)}`,
              where: `${relative}:${line} <${tagOf(trigger)}>`,
              problems,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

const violations = tsxFiles(APP_DIR).flatMap((file) =>
  scanFile(file, path.relative(WEBAPP_DIR, file).split(path.sep).join("/"))
);

describe("SimpleTooltip triggers", () => {
  it("names every icon-only control it wraps", () => {
    const offenders = violations
      .filter((v) => v.problems.includes("unnamed") && !UNNAMED_BASELINE.has(v.key))
      .map((v) => v.where);

    expect(offenders).toEqual([]);
  });

  it("passes asChild so the trigger does not wrap the control in another button", () => {
    const offenders = violations
      .filter((v) => v.problems.includes("no-asChild") && !NO_AS_CHILD_BASELINE.has(v.key))
      .map((v) => v.where);

    expect(offenders).toEqual([]);
  });

  it("keeps the baselines honest — a listed site must still be found by the scan", () => {
    const keys = new Set(violations.map((v) => v.key));
    const stale = [...UNNAMED_BASELINE, ...NO_AS_CHILD_BASELINE].filter((key) => !keys.has(key));

    expect(stale).toEqual([]);
  });
});
