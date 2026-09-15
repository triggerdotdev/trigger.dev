// Every declared parameter must actually reach the delegate.
//
// The compiler cannot check this. A forwarder that omits a trailing OPTIONAL argument compiles
// cleanly, and the effect is silent: `findLatestExecutionSnapshot` would stop applying its tenant
// scope, and `upsertWaitpointTag` would stop applying its residency hint, so a write would land on
// the wrong database. Both of those shipped in this file before this test existed.
//
// So this reads the source of the base against the source of the interface and asserts that each
// forward passes exactly the parameters its signature declares, in order. Source-level, because
// that is the only place the property is visible.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname);
const interfaceSource = readFileSync(join(dir, "types.ts"), "utf8");
const baseSource = readFileSync(join(dir, "delegatingRunStore.ts"), "utf8");

/** Replaces comments and string bodies with spaces, so neither can shift a brace depth. */
function blank(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1;
      out += quote + " ".repeat(Math.max(0, j - i - 1)) + (text[j] ?? "");
      i = j + 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

function interfaceBody(source: string): string {
  const blanked = blank(source);
  const decl = "export interface RunStore {";
  const start = blanked.indexOf(decl) + decl.length;
  let depth = 1;
  let end = start;
  while (depth > 0 && end < blanked.length) {
    if (blanked[end] === "{") depth += 1;
    else if (blanked[end] === "}") depth -= 1;
    if (depth > 0) end += 1;
  }
  return blanked.slice(start, end);
}

/** Splits a balanced parameter list on top-level commas. */
function splitParams(signature: string): string[] {
  // A generic member reads `name<T extends X>(...)`, so the parameter list starts after the
  // balanced angle block, not at the first parenthesis.
  let searchFrom = 0;
  const angle = signature.indexOf("<");
  const paren = signature.indexOf("(");
  if (angle !== -1 && angle < paren) {
    let angleDepth = 0;
    for (let i = angle; i < signature.length; i++) {
      if (signature[i] === "<") angleDepth += 1;
      else if (signature[i] === ">") {
        angleDepth -= 1;
        if (angleDepth === 0) {
          searchFrom = i;
          break;
        }
      }
    }
  }

  const open = signature.indexOf("(", searchFrom);
  let depth = 0;
  let close = open;
  for (let i = open; i < signature.length; i++) {
    if ("([{<".includes(signature[i]!)) depth += 1;
    else if (")]}>".includes(signature[i]!)) {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const inner = signature.slice(open + 1, close);
  const parts: string[] = [];
  let level = 0;
  let current = "";
  for (const ch of inner) {
    if ("([{<".includes(ch)) level += 1;
    else if (")]}>".includes(ch)) level -= 1;
    if (ch === "," && level === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function paramNames(signature: string): string[] {
  return splitParams(signature)
    .map((p) => /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(p)?.[1])
    .filter((n): n is string => Boolean(n));
}

/** Member name to its declared parameter names, for members with a single signature. */
function declaredParams(): Map<string, string[]> {
  const body = interfaceBody(interfaceSource);
  const spans: string[] = [];
  let level = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if ("{([".includes(ch)) level += 1;
    else if ("})]".includes(ch)) level -= 1;
    else if (ch === ";" && level === 0) {
      spans.push(body.slice(from, i));
      from = i + 1;
    }
  }

  const seen = new Map<string, string[][]>();
  for (const span of spans) {
    const match = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*[(<]/.exec(span);
    if (!match) continue;
    const name = match[1]!;
    seen.set(name, [...(seen.get(name) ?? []), paramNames(span)]);
  }

  // Overloaded members forward through a cast and apply the whole argument list, so they are not
  // subject to this check.
  return new Map(
    [...seen].filter(([, sigs]) => sigs.length === 1).map(([n, sigs]) => [n, sigs[0]!])
  );
}

describe("the pass-through forwards every declared parameter", () => {
  const declared = declaredParams();

  it("parsed the interface, so a parse failure cannot pass this suite", () => {
    expect(declared.size).toBeGreaterThan(50);
    expect(declared.get("expireParkedRun")).toEqual(["runId", "data", "tx"]);
    expect(declared.get("findLatestExecutionSnapshot")).toEqual([
      "runId",
      "client",
      "environmentId",
    ]);
  });

  it("passes exactly the declared parameters, in order, for every single-signature member", () => {
    const wrong: string[] = [];

    for (const [name, params] of declared) {
      const forward = new RegExp(`return this\\.delegate\\.${name}\\(([^;]*)\\);`).exec(baseSource);

      if (!forward) {
        wrong.push(`${name}: no forward found`);
        continue;
      }

      const passed = forward[1]!
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);

      if (passed.join(",") !== params.join(",")) {
        wrong.push(`${name}: declares (${params.join(", ")}) but forwards (${passed.join(", ")})`);
      }
    }

    expect(wrong).toEqual([]);
  });
});
