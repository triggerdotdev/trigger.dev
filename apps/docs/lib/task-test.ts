import { parse } from "@babel/parser";
import type { Expression, Node } from "@babel/types";

/** A task defined in a sample, with an example payload the same sample triggers it with. */
type TaskTest = { taskId: string; payload: unknown };

// Same limit as MAX_PREFILL_PAYLOAD_BYTES in apps/webapp/app/utils/testPayloadPrefill.server.ts.
/** The dashboard ignores bigger prefills (UTF-8 bytes of the JSON); the docs never link one. */
export const MAX_PAYLOAD_BYTES = 4096;

const TASK_FACTORIES = new Set(["task", "schemaTask"]);
const TRIGGERS = new Set(["trigger", "triggerAndWait"]);
const CODE_LANGS = new Set(["ts", "typescript", "tsx", "js", "javascript", "jsx", "mts", "mjs"]);

export function isScriptLang(lang: string | null | undefined): boolean {
  return CODE_LANGS.has((lang ?? "").toLowerCase());
}

const TRIGGER_TEXT = /\.trigger(AndWait)?\b/;
const TASK_TEXT = /\b(task|schemaTask)\s*[(<]/;

const NOT_LITERAL = Symbol("not literal");

/** The JSON value of a static literal, or NOT_LITERAL for anything that needs evaluating. */
function literal(node: Node | null | undefined): unknown {
  if (!node) return NOT_LITERAL;
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return literal(node.expression);
    case "StringLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NumericLiteral":
      return Number.isFinite(node.value) ? node.value : NOT_LITERAL;
    case "NullLiteral":
      return null;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? node.quasis[0]!.value.cooked : NOT_LITERAL;
    case "UnaryExpression": {
      if (node.operator !== "-" || node.argument.type !== "NumericLiteral") return NOT_LITERAL;
      return -node.argument.value;
    }
    case "ArrayExpression": {
      const out: unknown[] = [];
      for (const el of node.elements) {
        const value = el?.type === "SpreadElement" ? NOT_LITERAL : literal(el);
        if (value === NOT_LITERAL) return NOT_LITERAL;
        out.push(value);
      }
      return out;
    }
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties) {
        if (prop.type !== "ObjectProperty" || prop.computed || prop.shorthand) return NOT_LITERAL;
        const key =
          prop.key.type === "Identifier"
            ? prop.key.name
            : prop.key.type === "StringLiteral" || prop.key.type === "NumericLiteral"
              ? String(prop.key.value)
              : undefined;
        if (key === undefined) return NOT_LITERAL;
        const value = literal(prop.value);
        if (value === NOT_LITERAL) return NOT_LITERAL;
        out[key] = value;
      }
      return out;
    }
    default:
      return NOT_LITERAL;
  }
}

type Found = {
  /** Task ids defined in this block, in source order. */
  defined: string[];
  /** Variable holding a task -> its id. */
  vars: Map<string, string>;
  /** Trigger calls with a literal payload: by task id, or by the variable they call. */
  calls: Array<{ taskId?: string; variable?: string; payload: unknown }>;
};

// A call the sample says fails ("// this will throw an error") isn't an example payload.
const FAILS = /\b(throws?|errors?|invalid|fails?)\b/i;

function scan(code: string): Found | undefined {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return undefined; // samples with `...` and other prose in code don't parse; they get no button
  }

  const found: Found = { defined: [], vars: new Map(), calls: [] };
  const failLines = new Set<number>();
  for (const c of ast.comments ?? [])
    if (c.loc && FAILS.test(c.value)) failLines.add(c.loc.start.line);
  const saysItFails = (node: Node) => {
    const start = node.loc?.start.line ?? 0;
    const end = node.loc?.end.line ?? start;
    for (let line = start - 1; line <= end; line++) if (failLines.has(line)) return true;
    return false;
  };

  const visit = (node: Node, parent: Node | undefined) => {
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const [first, second] = node.arguments;

      // task({ id: "..." }) / schemaTask({ id: "..." })
      if (callee.type === "Identifier" && TASK_FACTORIES.has(callee.name)) {
        const idProp =
          first?.type === "ObjectExpression"
            ? first.properties.find(
                (p) =>
                  p.type === "ObjectProperty" &&
                  !p.computed &&
                  p.key.type === "Identifier" &&
                  p.key.name === "id"
              )
            : undefined;
        const id = idProp?.type === "ObjectProperty" ? literal(idProp.value) : NOT_LITERAL;
        if (typeof id === "string" && id) {
          found.defined.push(id);
          if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier")
            found.vars.set(parent.id.name, id);
        }
      }

      // tasks.trigger("id", payload) / myTask.trigger(payload), and their AndWait forms
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        TRIGGERS.has(callee.property.name) &&
        callee.object.type === "Identifier" &&
        !saysItFails(node)
      ) {
        if (callee.object.name === "tasks") {
          const taskId = literal(first as Expression | undefined);
          const payload = literal(second as Expression | undefined);
          if (typeof taskId === "string" && payload !== NOT_LITERAL)
            found.calls.push({ taskId, payload });
        } else {
          const payload = literal(first as Expression | undefined);
          if (payload !== NOT_LITERAL) found.calls.push({ variable: callee.object.name, payload });
        }
      }
    }

    for (const key of Object.keys(node) as Array<keyof Node>) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
      const value = node[key] as unknown;
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child.type === "string") visit(child as Node, node);
      } else if (value && typeof (value as Node).type === "string") {
        visit(value as Node, node);
      }
    }
  };
  visit(ast, undefined);
  return found;
}

function payloadBytes(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/**
 * For one sample (the script blocks of one section: a block, a CodeGroup, or "define the task"
 * followed by "trigger it"), which blocks get a "Test in dashboard" button: a block that defines a
 * task the sample also triggers with a literal payload. Returns block index -> its test. Payloads
 * past MAX_PAYLOAD_BYTES, and calls the sample says fail, are skipped.
 */
export function findTaskTests(blocks: string[]): Map<number, TaskTest> {
  // Most sections can't match; skip parsing them.
  if (!blocks.some((b) => TRIGGER_TEXT.test(b)) || !blocks.some((b) => TASK_TEXT.test(b)))
    return new Map();
  const scans = blocks.map(scan);
  // `myTask.trigger(...)` resolves to the task its own block declares as `myTask`, else to the one
  // task the other blocks declare under that name (none or several: no match).
  const resolve = (variable: string, own: Found) => {
    const local = own.vars.get(variable);
    if (local) return local;
    const ids = new Set(
      scans.flatMap((s) => (s?.vars.has(variable) ? [s.vars.get(variable)!] : []))
    );
    return ids.size === 1 ? [...ids][0] : undefined;
  };

  // First literal payload per task id, across the whole sample.
  const payloads = new Map<string, unknown>();
  for (const s of scans) {
    if (!s) continue;
    for (const call of s.calls) {
      const taskId = call.taskId ?? (call.variable ? resolve(call.variable, s) : undefined);
      if (!taskId || payloads.has(taskId) || payloadBytes(call.payload) > MAX_PAYLOAD_BYTES)
        continue;
      payloads.set(taskId, call.payload);
    }
  }

  const out = new Map<number, TaskTest>();
  scans.forEach((s, index) => {
    const taskId = s?.defined.find((id) => payloads.has(id));
    if (taskId) out.set(index, { taskId, payload: payloads.get(taskId) });
  });
  return out;
}

/** base64url of the payload's JSON: the `payload` param the dashboard Test page reads. */
export function encodePayload(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The dashboard path for testing a task with a payload; goes through dashboardLink(). `env=dev`
 * because readers run samples with `trigger dev`, not the environment they last used.
 */
export function taskTestPath(test: TaskTest): string {
  return `/_/test/tasks/${encodeURIComponent(test.taskId)}?env=dev&payload=${encodePayload(test.payload)}`;
}
