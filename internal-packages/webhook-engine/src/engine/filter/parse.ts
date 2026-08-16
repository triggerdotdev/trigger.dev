import type { FilterAst, FilterOp, FilterScalar, FilterValue } from "@trigger.dev/core/v3";
import { FilterParseError, MAX_FILTER_CLAUSES } from "./types.js";

// Runtime recursive-descent parser: filter string -> FilterAst. Mirrors the type-level grammar in
// core/schemas/webhookFilter.ts (kept in sync via the golden corpus in filter.test.ts). Runs at
// index/deploy time, never at ingest. Throws FilterParseError on any structural problem.

const CMP_TO_OP: Record<string, FilterOp> = {
  "==": "eq",
  "!=": "neq",
  ">": "gt",
  "<": "lt",
  ">=": "gte",
  "<=": "lte",
};
const WORD_OPS: Record<string, FilterOp> = {
  in: "in",
  startsWith: "startsWith",
  endsWith: "endsWith",
  contains: "contains",
};
const NAMESPACES = new Set(["event", "header", "webhook"]);

type Tok = {
  t:
    | "lparen"
    | "rparen"
    | "lbracket"
    | "rbracket"
    | "comma"
    | "and"
    | "or"
    | "cmp"
    | "word"
    | "string"
    | "number";
  v: string;
};

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    const simple = {
      "(": "lparen",
      ")": "rparen",
      "[": "lbracket",
      "]": "rbracket",
      ",": "comma",
    } as const;
    if (c in simple) {
      toks.push({ t: simple[c as keyof typeof simple], v: c });
      i++;
      continue;
    }
    if (c === "&" && s[i + 1] === "&") {
      toks.push({ t: "and", v: "&&" });
      i += 2;
      continue;
    }
    if (c === "|" && s[i + 1] === "|") {
      toks.push({ t: "or", v: "||" });
      i += 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== "'") j++;
      if (j >= s.length) throw new FilterParseError("unterminated string literal");
      toks.push({ t: "string", v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
      toks.push({ t: "cmp", v: two });
      i += 2;
      continue;
    }
    if (c === ">" || c === "<") {
      toks.push({ t: "cmp", v: c });
      i++;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d+(\.\d+)?/.exec(s.slice(i));
      if (m) {
        toks.push({ t: "number", v: m[0] });
        i += m[0].length;
        continue;
      }
    }
    const w = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(s.slice(i));
    if (w) {
      toks.push({ t: "word", v: w[0] });
      i += w[0].length;
      continue;
    }
    throw new FilterParseError(`unexpected character "${c}"`);
  }
  return toks;
}

export function parseFilter(input: string): FilterAst {
  const toks = tokenize(input);
  if (toks.length === 0) throw new FilterParseError("empty filter");
  let pos = 0;
  let clauseCount = 0;
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok | undefined => toks[pos++];

  function parseOr(): FilterAst {
    const branches = [parseAnd()];
    while (peek()?.t === "or") {
      next();
      branches.push(parseAnd());
    }
    return branches.length === 1 ? branches[0] : { kind: "or", clauses: branches };
  }
  function parseAnd(): FilterAst {
    const branches = [parseUnary()];
    while (peek()?.t === "and") {
      next();
      branches.push(parseUnary());
    }
    return branches.length === 1 ? branches[0] : { kind: "and", clauses: branches };
  }
  function parseUnary(): FilterAst {
    if (peek()?.t === "lparen") {
      next();
      const inner = parseOr();
      if (next()?.t !== "rparen") throw new FilterParseError('expected ")"');
      return inner;
    }
    return parseClause();
  }
  function parseClause(): FilterAst {
    if (++clauseCount > MAX_FILTER_CLAUSES) {
      throw new FilterParseError(
        `filter too complex (> ${MAX_FILTER_CLAUSES} clauses); split it or move logic to the handler`
      );
    }
    const pathTok = next();
    if (!pathTok || pathTok.t !== "word") throw new FilterParseError("expected a field path");
    const path = pathTok.v;
    if (!NAMESPACES.has(path.split(".")[0])) {
      throw new FilterParseError(`field must start with event./header./webhook., got "${path}"`);
    }
    // Quantifier: `arrPath any|all ( subPath op value )` — sub-clause resolves against each element.
    const q = peek();
    if (q?.t === "word" && (q.v === "any" || q.v === "all")) {
      next();
      if (next()?.t !== "lparen") throw new FilterParseError(`expected "(" after "${q.v}"`);
      const subPathTok = next();
      if (!subPathTok || subPathTok.t !== "word") {
        throw new FilterParseError("expected a field path inside the quantifier");
      }
      const subOp = parseOp(subPathTok.v);
      const subValue = parseScalar();
      if (next()?.t !== "rparen") throw new FilterParseError('expected ")"');
      return {
        kind: "quantifier",
        mode: q.v,
        path,
        clause: { path: subPathTok.v, op: subOp, value: subValue },
      };
    }
    const op = parseOp(path);
    // An unquoted, namespace-prefixed operand is a field reference (field-to-field), not a literal.
    const operand = peek();
    if (operand?.t === "word" && NAMESPACES.has(operand.v.split(".")[0])) {
      next();
      return { kind: "clause", path, op, valueRef: operand.v };
    }
    return { kind: "clause", path, op, value: parseValue() };
  }
  function parseOp(path: string): FilterOp {
    const t = next();
    if (t?.t === "cmp") return CMP_TO_OP[t.v];
    if (t?.t === "word" && t.v === "not") {
      if (next()?.v !== "in") throw new FilterParseError('expected "in" after "not"');
      return "nin";
    }
    if (t?.t === "word" && t.v in WORD_OPS) return WORD_OPS[t.v];
    throw new FilterParseError(`expected an operator after "${path}"`);
  }
  function parseValue(): FilterValue {
    if (peek()?.t === "lbracket") {
      next();
      const items: FilterScalar[] = [];
      while (peek() && peek()?.t !== "rbracket") {
        items.push(parseScalar());
        if (peek()?.t === "comma") next();
        else break;
      }
      if (next()?.t !== "rbracket") throw new FilterParseError('expected "]"');
      return items;
    }
    return parseScalar();
  }
  function parseScalar(): FilterScalar {
    const t = next();
    if (!t) throw new FilterParseError("expected a value");
    if (t.t === "string") return t.v;
    if (t.t === "number") return Number(t.v);
    if (t.t === "word") {
      if (t.v === "true") return true;
      if (t.v === "false") return false;
      if (t.v === "null") return null;
    }
    throw new FilterParseError(`unexpected value "${t.v}"`);
  }

  const ast = parseOr();
  if (pos < toks.length) throw new FilterParseError(`unexpected trailing token "${peek()?.v}"`);
  return ast;
}
