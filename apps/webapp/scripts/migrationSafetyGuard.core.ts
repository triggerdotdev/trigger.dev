/**
 * Pure rules for the Postgres migration safety guard. No filesystem access; the CLI in
 * `migrationSafetyGuard.ts` feeds it file contents and reports the result.
 *
 * A migration may be re-run after a partial apply, so every statement must be idempotent:
 * creates guard with IF NOT EXISTS, drops guard with IF EXISTS, and statements Postgres cannot
 * guard (CREATE TYPE, ADD CONSTRAINT, RENAME) live inside a DO block, under an IF ... THEN that
 * checks the catalog first or in a block whose EXCEPTION handler swallows the duplicate error.
 * Indexes on tables that already exist in production must be built CONCURRENTLY, and because
 * Postgres runs a multi-statement migration script as one implicit transaction, where
 * CONCURRENTLY is illegal, such a statement must be the only one in its file.
 *
 * Escape hatch: a `-- migration-guard: allow <reason>` comment on the line above a statement, or
 * trailing it on the same line, suppresses every rule for that statement. The reason is mandatory
 * and a directive that suppresses nothing is itself a violation, so stale hatches cannot linger.
 */

export type Allow = { reason: string; line: number };

export type Statement = {
  sql: string;
  line: number;
  allow: Allow | null;
};

export type Parsed = {
  statements: Statement[];
  /** Directives that ended up attached to no statement: dangling at EOF, stacked, or trailing an already-allowed statement. */
  unattachedAllows: Allow[];
};

export type Violation = {
  line: number;
  rule: string;
  message: string;
  hint: string;
  statement: string;
};

export type CheckResult = {
  violations: Violation[];
  suppressed: number;
};

const ALLOW_DIRECTIVE = /^\s*migration-guard:\s*allow\b[ \t:]*(.*?)\s*$/i;

/**
 * If a dollar-quoted literal opens at `i`, returns its delimiter and the index just past the closing
 * delimiter (the end of the text when unterminated). A `$` glued to an identifier is not a delimiter.
 */
function dollarQuoteAt(
  text: string,
  i: number
): { delim: string; end: number; closed: boolean } | null {
  if (text[i] !== "$") return null;
  if (/[\p{L}\p{N}_]/u.test(text[i - 1] ?? "")) return null;
  const tag = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(text.slice(i));
  if (!tag) return null;
  const delim = tag[0];
  const close = text.indexOf(delim, i + delim.length);
  return close === -1
    ? { delim, end: text.length, closed: false }
    : { delim, end: close + delim.length, closed: true };
}

/** True when the quote at `i` opens an E'...' string, whose backslashes escape the next character. */
function isEscapeStringAt(text: string, i: number): boolean {
  return /(?:^|[^A-Za-z0-9_])[eE]$/.test(text.slice(Math.max(0, i - 2), i));
}

/**
 * End (exclusive) of the `'` or `"` literal opening at `i`, honouring doubled quotes and, for
 * E-strings, backslash escapes. Unterminated literals run to the end of the text.
 */
function quoteEnd(text: string, i: number): { end: number; closed: boolean } {
  const q = text[i];
  const escapes = q === "'" && isEscapeStringAt(text, i);
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (escapes && c === "\\") {
      j += 2;
      continue;
    }
    if (c === q) {
      if (text[j + 1] === q) {
        j += 2;
        continue;
      }
      return { end: j + 1, closed: true };
    }
    j++;
  }
  return { end: text.length, closed: false };
}

/**
 * Splits SQL into top-level statements, tracking the source line each starts on and any
 * `migration-guard: allow` directive attached to it. Strings, quoted identifiers, dollar-quoted
 * bodies and both comment styles are respected so a `;` inside them does not end a statement.
 */
export function parseMigration(source: string): Parsed {
  const statements: Statement[] = [];
  let buf = "";
  let startLine = 0;
  let line = 1;
  let pendingAllow: Allow | null = null;
  const unattachedAllows: Allow[] = [];
  let lastFlushLine = 0;
  let i = 0;
  const n = source.length;

  const flush = () => {
    if (buf.trim() !== "") {
      statements.push({ sql: buf.trim(), line: startLine, allow: pendingAllow });
      pendingAllow = null;
      lastFlushLine = line;
    }
    buf = "";
    startLine = 0;
  };

  const push = (text: string, atLine: number) => {
    if (startLine === 0 && text.trim() !== "") startLine = atLine;
    buf += text;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "-" && next === "-") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      const m = ALLOW_DIRECTIVE.exec(source.slice(i + 2, stop));
      if (m) {
        const allow = { reason: m[1].trim(), line };
        const previous = statements[statements.length - 1];
        const trailsPrevious = previous && lastFlushLine === line && buf.trim() === "";
        if (trailsPrevious) {
          if (previous.allow === null) previous.allow = allow;
          else unattachedAllows.push(allow);
        } else {
          if (pendingAllow) unattachedAllows.push(pendingAllow);
          pendingAllow = allow;
        }
      }
      i = stop;
      continue;
    }

    if (ch === "/" && next === "*") {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (source[j] === "/" && source[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (source[j] === "*" && source[j + 1] === "/") {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else {
          if (source[j] === "\n") line++;
          j++;
        }
      }
      push(" " + "\n".repeat(countLines(source.slice(i, j))), line);
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const { end } = quoteEnd(source, i);
      const chunk = source.slice(i, end);
      const at = line;
      line += countLines(chunk);
      push(chunk, at);
      i = end;
      continue;
    }

    const dollar = dollarQuoteAt(source, i);
    if (dollar) {
      const chunk = source.slice(i, dollar.end);
      const at = line;
      line += countLines(chunk);
      push(chunk, at);
      i = dollar.end;
      continue;
    }

    if (ch === ";") {
      flush();
      i++;
      continue;
    }

    push(ch, line);
    if (ch === "\n") line++;
    i++;
  }
  flush();
  if (pendingAllow) unattachedAllows.push(pendingAllow);

  return { statements, unattachedAllows };
}

export function splitStatements(source: string): Statement[] {
  return parseMigration(source).statements;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QIDENT = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Quoted identifiers keep their case; unquoted ones fold to lower case, as Postgres does. */
function unquote(ident: string): string {
  const t = ident.trim();
  if (t.startsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
  return t.toLowerCase();
}

/** `schema.name` in canonical form; an unqualified name is assumed to be in `public`. */
function tableKey(qualified: string): string {
  const parts = qualified.split(".").map(unquote);
  const name = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2] : "public";
  return `${schema}.${name}`;
}

/**
 * Replaces the contents of string literals and quoted identifiers with filler of the same length,
 * so keyword regexes cannot match inside them while match positions still line up with the original.
 */
function maskLiterals(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  const fill = (from: number, to: number, open: string, close: string) => {
    out += open + "_".repeat(Math.max(0, to - from - open.length - close.length)) + close;
  };
  while (i < n) {
    const ch = text[i];
    const dollar = dollarQuoteAt(text, i);
    if (dollar) {
      fill(i, dollar.end, dollar.delim, dollar.closed ? dollar.delim : "");
      i = dollar.end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const { end, closed } = quoteEnd(text, i);
      fill(i, end, ch, closed ? ch : "");
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The body of a DO statement and where it starts in `raw`. Bodies are normally dollar-quoted; a
 * plain single-quoted body is accepted too, with its doubled quotes unescaped, so it cannot hide
 * DDL. An escape (E'...') or Unicode (U&'...') string body is reported as unsupported rather than
 * decoded, since its text differs from what Postgres executes.
 */
function doBody(raw: string): { body: string | null; bodyStart: number } | null {
  for (let i = 0; i < raw.length; i++) {
    const dollar = dollarQuoteAt(raw, i);
    if (dollar) {
      const bodyStart = i + dollar.delim.length;
      return {
        body: raw.slice(bodyStart, dollar.closed ? dollar.end - dollar.delim.length : raw.length),
        bodyStart,
      };
    }
    if (raw[i] === "'") {
      if (/(?:^|\s)(?:[eE]|[uU]&)$/.test(raw.slice(0, i))) return { body: null, bodyStart: i };
      const { end, closed } = quoteEnd(raw, i);
      const inner = raw.slice(i + 1, closed ? end - 1 : end);
      return { body: inner.replace(/''/g, "'"), bodyStart: i + 1 };
    }
  }
  return null;
}

/**
 * Offset of the top-level command in a statement that opens with a WITH clause, or 0. Depth is
 * tracked on the masked text so parentheses inside literals do not count.
 */
function leadingCteOffset(masked: string): number {
  if (!/^WITH\b/i.test(masked)) return 0;
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (
      depth === 0 &&
      /[A-Za-z]/.test(c) &&
      (i === 0 || !/[A-Za-z0-9_]/.test(masked[i - 1]))
    ) {
      if (/^(?:INSERT|UPDATE|DELETE|SELECT|MERGE)\b/i.test(masked.slice(i))) return i;
    }
  }
  return 0;
}

type Action = { text: string; offset: number };

/** Splits `ALTER TABLE` actions on commas outside parentheses, brackets and quotes. */
function splitActions(body: string): Action[] {
  const out: Action[] = [];
  let depth = 0;
  let start = 0;
  const emit = (end: number) => {
    const raw = body.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) out.push({ text: raw.trim(), offset: start + lead });
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"') {
      i = quoteEnd(body, i).end - 1;
      continue;
    }
    const dollar = dollarQuoteAt(body, i);
    if (dollar) {
      i = dollar.end - 1;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      emit(i);
      start = i + 1;
    }
  }
  emit(body.length);
  return out;
}

function countLines(text: string): number {
  let count = 0;
  for (const c of text) if (c === "\n") count++;
  return count;
}

const CREATE_TABLE_RE = new RegExp(
  String.raw`^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(${QIDENT})`,
  "i"
);
const CREATE_TABLE_ANYWHERE_RE =
  /\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\b/gi;
const CREATE_INDEX_RE = new RegExp(
  String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s+)?ON\s+(ONLY\s+)?(${QIDENT})`,
  "i"
);
const CREATE_INDEX_ANYWHERE_RE = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi;
const CREATE_SIMPLE_RE =
  /^CREATE\s+(SCHEMA|EXTENSION|SEQUENCE|COLLATION|STATISTICS|MATERIALIZED\s+VIEW)\s+(IF\s+NOT\s+EXISTS\s+)?/i;
const CREATE_REPLACEABLE_RE =
  /^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|VIEW|TRIGGER|RULE|AGGREGATE)\b/i;
const CREATE_UNGUARDABLE_RE = /^CREATE\s+(DOMAIN|TYPE|POLICY|PUBLICATION)\b/i;
const ALTER_TYPE_ADD_VALUE_RE = /^ALTER\s+TYPE\b.*?\bADD\s+VALUE\s+(IF\s+NOT\s+EXISTS\s+)?/i;
const ALTER_TABLE_RE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QIDENT})\s*\*?\s*([\s\S]*)$`,
  "i"
);
const RENAME_OBJECT_RE = new RegExp(
  String.raw`^ALTER\s+(TYPE|INDEX|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?${QIDENT}\s+RENAME\b`,
  "i"
);
const ALTER_INDEX_ATTACH_RE = new RegExp(
  String.raw`^ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?${QIDENT}\s+ATTACH\s+PARTITION\b`,
  "i"
);
const DROP_RE =
  /^DROP\s+(TABLE|INDEX|TYPE|DOMAIN|SEQUENCE|VIEW|MATERIALIZED\s+VIEW|SCHEMA|EXTENSION|FUNCTION|PROCEDURE|TRIGGER|RULE|POLICY)\s+(CONCURRENTLY\s+)?(IF\s+EXISTS\s+)?/i;
const INSERT_RE = /^INSERT\s+INTO\b/i;
const ON_CONFLICT_RE = /\bON\s+CONFLICT\b/i;

const ADD_CONSTRAINT_RE = /^ADD\s+(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|EXCLUDE)\b/i;
const ADD_COLUMN_RE = new RegExp(
  String.raw`^ADD\s+(?:COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?(${IDENT})`,
  "i"
);
const DROP_ACTION_RE = new RegExp(
  String.raw`^DROP\s+(CONSTRAINT|COLUMN)?\s*(IF\s+EXISTS\s+)?(${IDENT})`,
  "i"
);
const ADD_NAMED_CONSTRAINT_RE = new RegExp(String.raw`^ADD\s+CONSTRAINT\s+(${IDENT})`, "i");
const DROP_CONSTRAINT_IF_EXISTS_RE = new RegExp(
  String.raw`^DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+(${IDENT})`,
  "i"
);
const UNGUARDABLE_ACTION_RE = /^((?:ATTACH|DETACH)\s+PARTITION|SET\s+SCHEMA|(?:NO\s+)?INHERIT)\b/i;
const RENAME_ACTION_RE = /^RENAME\b/i;

const DO_BLOCK_HINT =
  "Postgres has no IF NOT EXISTS for this statement. Wrap it in a DO $$ ... $$ block, under " +
  "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...') THEN ... END IF, or give the block an " +
  "EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL handler.";

const RENAME_HINT =
  "A second run fails because the old name no longer exists. Wrap it in a DO $$ ... $$ block that checks " +
  "the catalog for the old name first (pg_attribute, pg_type, pg_class) and renames only when it is present.";

const CONCURRENTLY_HINT =
  "CONCURRENTLY cannot run inside a transaction, and Postgres runs a multi-statement migration " +
  "script as one implicit transaction. Put this statement in its own migration file with nothing else in it.";

const CREATE_INDEX_CONCURRENTLY_HINT =
  "A plain CREATE INDEX takes a SHARE lock that blocks writes for the whole build. Use CREATE INDEX " +
  "CONCURRENTLY IF NOT EXISTS in its own migration file. Indexes on a table created in the same file are exempt, " +
  "and so is ON ONLY on a partitioned parent (Postgres cannot build those concurrently; index each partition " +
  "CONCURRENTLY, then attach).";

type Ctx = {
  createdTables: Set<string>;
  /** Records a violation at an absolute source line; `statement` overrides the collector's default excerpt. */
  add: (rule: string, message: string, hint: string, line: number, statement?: string) => void;
  /** Counts violations that an allow directive suppressed. */
  suppress: (count: number) => void;
};

/** A Ctx that appends to `into`, stamping `excerptText` on violations that carry no excerpt of their own. */
function collect(
  into: Violation[],
  excerptText: string,
  createdTables: Set<string>,
  suppress: Ctx["suppress"]
): Ctx {
  return {
    createdTables,
    add: (rule, message, hint, line, statement) =>
      into.push({ line, rule, message, hint, statement: statement ?? excerptText }),
    suppress,
  };
}

/** Every CREATE INDEX in `text`, found on the masked form so literals cannot fake one. */
function findIndexes(text: string) {
  const masked = maskLiterals(text);
  const out: { ifNotExists: boolean; only: boolean; table: string }[] = [];
  let m: RegExpExecArray | null;
  CREATE_INDEX_ANYWHERE_RE.lastIndex = 0;
  while ((m = CREATE_INDEX_ANYWHERE_RE.exec(masked))) {
    const full = CREATE_INDEX_RE.exec(text.slice(m.index));
    if (full) {
      out.push({ ifNotExists: Boolean(full[3]), only: Boolean(full[4]), table: full[5] });
    }
  }
  return out;
}

/** Every CREATE TABLE in `text`, including ones nested in a DO body. */
function findCreatedTables(text: string): string[] {
  const masked = maskLiterals(text);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  CREATE_TABLE_ANYWHERE_RE.lastIndex = 0;
  while ((m = CREATE_TABLE_ANYWHERE_RE.exec(masked))) {
    const full = CREATE_TABLE_RE.exec(text.slice(m.index));
    if (full) out.push(tableKey(full[2]));
  }
  return out;
}

type DoChunk = {
  text: string;
  raw: string;
  masked: string;
  line: number;
  allow: Allow | null;
  block: number;
};

/**
 * Inspects the plpgsql body statement by statement. DDL under an IF whose predicate reads retry
 * state (EXISTS (...), FOUND, a pg_catalog or information_schema lookup, either polarity, either
 * branch), or in a block whose own
 * EXCEPTION handler names a duplicate_* / undefined_* condition without re-raising, is taken as
 * guarded. Any other DDL must pass the ordinary rules itself. A CREATE INDEX on an existing table is
 * flagged at any depth because CONCURRENTLY is impossible inside a DO block. Allow directives
 * inside the body apply to the plpgsql statement they annotate.
 */
function checkDoBlock(raw: string, statementLine: number, ctx: Ctx) {
  const extracted = doBody(raw);
  if (!extracted) return;
  const { body, bodyStart } = extracted;
  if (body === null) {
    ctx.add(
      "do-body-unsupported",
      "DO body is an escape or Unicode string constant, which the guard does not decode.",
      "Write the body as a dollar-quoted string ($$ ... $$) so it can be checked, or add a migration-guard: allow directive.",
      statementLine
    );
    return;
  }
  const bodyLine = statementLine + countLines(raw.slice(0, bodyStart));
  const lineOf = (bodyRelative: number) => bodyLine + bodyRelative - 1;
  const parsed = parseMigration(body);

  const unattached = (allow: Allow) =>
    ctx.add(
      "allow-unused",
      "migration-guard: allow is not attached to any statement.",
      "Each statement takes one directive, on the line above it or trailing it on the same line. Remove stacked or stray directives.",
      lineOf(allow.line)
    );

  const chunks: DoChunk[] = [];
  const handled = new Set<number>();
  const inHandler = new Set<number>();
  const blockStack: number[] = [];
  let nextBlock = 0;
  const RE_RAISES = /^RAISE\b(?!\s+(?:NOTICE|LOG|INFO|WARNING|DEBUG)\b)/i;
  const DUPLICATE_CONDITION =
    /\b(?:duplicate_[a-z_]+|undefined_[a-z_]+|unique_violation)\b|\bSQLSTATE\s*'(?:42710|42P07|42701|42P06|42723|42P04|42P03|42712|42P05|42704|42P01|42703|42883|3F000|23505)'/i;
  const BLOCK_END = /^END(?:\s+(?!(?:IF|LOOP|CASE)\b)[A-Za-z_][A-Za-z0-9_]*)?\s*$/i;
  for (const s of parsed.statements) {
    const label = /^<<[A-Za-z_][A-Za-z0-9_]*>>\s*/.exec(s.sql)?.[0] ?? "";
    let raw = s.sql.slice(label.length);
    let text = normalize(raw);
    let masked = maskLiterals(text);
    let line = s.line + countLines(label);
    if (/^BEGIN\b/i.test(masked)) {
      blockStack.push(nextBlock++);
      const rest = raw.replace(/^BEGIN/i, "");
      line += countLines(rest.slice(0, rest.length - rest.trimStart().length));
      raw = rest.trim();
      text = normalize(raw);
      masked = maskLiterals(text);
    }
    const block = blockStack[blockStack.length - 1] ?? -1;
    if (/^EXCEPTION\b/i.test(masked)) inHandler.add(block);
    const handlerArm = inHandler.has(block) && /^(EXCEPTION\s+)?WHEN\b/i.test(masked);
    const lateReRaise = inHandler.has(block) && RE_RAISES.test(masked);
    const structural = text === "" || BLOCK_END.test(masked) || handlerArm || lateReRaise;
    if (structural) {
      if (BLOCK_END.test(masked)) {
        blockStack.pop();
        inHandler.delete(block);
      }
      if (handlerArm) {
        const thenAt = masked.search(/\bTHEN\b/i);
        const conditions = thenAt === -1 ? text : text.slice(0, thenAt);
        const action = thenAt === -1 ? "" : masked.slice(thenAt + 4).trim();
        if (DUPLICATE_CONDITION.test(conditions) && !RE_RAISES.test(action)) handled.add(block);
      }
      if (lateReRaise) handled.delete(block);
      if (s.allow) unattached(s.allow);
      continue;
    }
    chunks.push({ text, raw, masked, line, allow: s.allow, block });
  }

  for (const allow of parsed.unattachedAllows) unattached(allow);

  const GUARDING_PREDICATE =
    /\b(?:NOT\s+)?EXISTS\s*\(|\b(?:NOT\s+)?FOUND\b|\bpg_[a-z_]+\b|\binformation_schema\b|\bto_reg[a-z]+\s*\(/i;
  const ifStack: boolean[] = [];
  const ddlInHandledBlock = new Map<number, number>();
  for (const chunk of chunks) {
    if (/^END\s+IF\b/i.test(chunk.masked)) {
      ifStack.pop();
      if (chunk.allow) unattached(chunk.allow);
      continue;
    }

    const local: Violation[] = [];
    const chunkLine = lineOf(chunk.line);
    const localCtx = collect(local, excerpt(chunk.text), ctx.createdTables, () => {});
    let target = chunk.raw;
    let targetLine = chunkLine;
    let controlFlow = false;
    const takeAfter = (offset: number) => {
      const rest = target.slice(offset);
      const lead = rest.length - rest.trimStart().length;
      targetLine += countLines(target.slice(0, offset + lead));
      target = rest.trim();
    };
    for (;;) {
      const targetMasked = maskLiterals(target);
      if (/^(IF|ELSIF)\b/i.test(targetMasked)) {
        const thenAt = targetMasked.search(/\bTHEN\b/i);
        const predicate = thenAt === -1 ? targetMasked : targetMasked.slice(0, thenAt);
        const guarding = GUARDING_PREDICATE.test(predicate);
        if (/^IF\b/i.test(targetMasked)) ifStack.push(guarding);
        else if (ifStack.length > 0) ifStack[ifStack.length - 1] = guarding;
        if (thenAt === -1) target = "";
        else takeAfter(thenAt + 4);
        controlFlow = true;
        continue;
      }
      if (/^ELSE\b/i.test(targetMasked)) {
        takeAfter(4);
        controlFlow = true;
        continue;
      }
      if (/^(CASE|WHEN)\b/i.test(targetMasked)) {
        const thenAt = targetMasked.search(/\bTHEN\b/i);
        if (thenAt === -1) target = "";
        else takeAfter(thenAt + 4);
        controlFlow = true;
        continue;
      }
      break;
    }
    const underIf = ifStack.some(Boolean);
    const guarded = underIf || handled.has(chunk.block);
    const targetNorm = normalize(target);
    const targetNormMasked = maskLiterals(targetNorm);
    const indexes = findIndexes(targetNorm);
    const isDdl = /^(CREATE|ALTER|DROP|INSERT|WITH)\b/i.test(targetNormMasked);

    if (isDdl && !underIf && handled.has(chunk.block) && !standsAlone(target, ctx.createdTables)) {
      const seen = ddlInHandledBlock.get(chunk.block) ?? 0;
      ddlInHandledBlock.set(chunk.block, seen + 1);
      if (seen > 0) {
        localCtx.add(
          "exception-block-multiple-ddl",
          "More than one statement relies on the same EXCEPTION handler.",
          "When the first statement raises the duplicate error on a re-run, control jumps to the handler and the " +
            "later statements never run. Give each statement its own BEGIN ... EXCEPTION ... END sub-block, or guard " +
            "each with IF NOT EXISTS (...) THEN ... END IF.",
          targetLine
        );
      }
    }

    for (const idx of indexes) {
      if (!idx.only && !ctx.createdTables.has(tableKey(idx.table))) {
        localCtx.add(
          "create-index-concurrently",
          `CREATE INDEX on existing table ${idx.table} inside a DO block cannot use CONCURRENTLY.`,
          "Move the index out of the DO block into its own migration file as CREATE INDEX CONCURRENTLY IF NOT EXISTS.",
          targetLine
        );
      }
    }

    if (/\bCONCURRENTLY\b/i.test(chunk.masked)) {
      localCtx.add(
        "concurrently-in-do-block",
        "CONCURRENTLY cannot be executed from a DO block.",
        "Postgres rejects CREATE/DROP INDEX CONCURRENTLY inside a function or DO block. Put the statement in its own " +
          "migration file with nothing else in it.",
        chunkLine
      );
    }

    if (!guarded && target !== "") {
      const why = controlFlow
        ? "inside a DO block under control flow whose predicate does not check the catalog"
        : "inside a DO block, outside any IF ... THEN guard, in a block with no EXCEPTION handler";
      const unguardedCtx: Ctx = {
        ...localCtx,
        add: (rule, message, hint, line, statement) =>
          localCtx.add(rule, `${message} (${why})`, hint, line, statement),
      };
      if (CREATE_INDEX_RE.test(targetNorm)) {
        if (!indexes[0]?.ifNotExists) {
          unguardedCtx.add(
            "create-index-if-not-exists",
            "CREATE INDEX must use IF NOT EXISTS.",
            'Write CREATE [UNIQUE] INDEX IF NOT EXISTS "name" ON ... so a retried migration is a no-op.',
            targetLine
          );
        }
      } else if (isDdl) {
        checkStatement(target, targetLine, unguardedCtx);
      }
    }

    applyAllow(chunk.allow, local, ctx);
  }
}

/** True when a statement passes the ordinary rules on its own, so it does not rely on an enclosing handler. */
function standsAlone(statement: string, createdTables: Set<string>): boolean {
  const found: Violation[] = [];
  checkStatement(
    statement,
    0,
    collect(found, "", createdTables, () => {})
  );
  return found.length === 0;
}

/** Forwards a statement's violations to `ctx`, honouring its allow directive. */
function applyAllow(allow: Allow | null, own: Violation[], ctx: Ctx) {
  if (allow && allow.reason === "") {
    ctx.add(
      "allow-reason-required",
      "migration-guard: allow needs a reason.",
      "Write `-- migration-guard: allow <why this statement is safe to apply as written>`.",
      allow.line
    );
    for (const v of own) ctx.add(v.rule, v.message, v.hint, v.line, v.statement);
  } else if (allow && own.length === 0) {
    ctx.add(
      "allow-unused",
      "migration-guard: allow suppresses nothing on this statement.",
      "Remove the directive, or move it to the statement it was meant for.",
      allow.line
    );
  } else if (allow) {
    ctx.suppress(own.length);
  } else {
    for (const v of own) ctx.add(v.rule, v.message, v.hint, v.line, v.statement);
  }
}

function checkStatement(raw: string, line: number, ctx: Ctx): { concurrently: boolean } {
  const norm = normalize(raw);
  let concurrently = false;

  if (/^DO\b/i.test(norm)) {
    checkDoBlock(raw, line, ctx);
    return { concurrently };
  }

  let m: RegExpExecArray | null;

  if ((m = CREATE_INDEX_RE.exec(norm))) {
    const [, , conc, ifNotExists, only, table] = m;
    concurrently = Boolean(conc);
    if (!ifNotExists) {
      ctx.add(
        "create-index-if-not-exists",
        "CREATE INDEX must use IF NOT EXISTS.",
        'Write CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS "name" ON ... so a retried migration is a no-op.',
        line
      );
    }
    if (!conc && !only && !ctx.createdTables.has(tableKey(table))) {
      ctx.add(
        "create-index-concurrently",
        `CREATE INDEX on existing table ${table} must use CONCURRENTLY.`,
        CREATE_INDEX_CONCURRENTLY_HINT,
        line
      );
    }
    return { concurrently };
  }

  if ((m = CREATE_TABLE_RE.exec(norm))) {
    if (!m[1]) {
      ctx.add(
        "create-if-not-exists",
        `CREATE TABLE ${m[2]} must use IF NOT EXISTS.`,
        "Write CREATE TABLE IF NOT EXISTS so a retried migration is a no-op.",
        line
      );
    }
    return { concurrently };
  }

  if ((m = CREATE_SIMPLE_RE.exec(norm))) {
    if (!m[2]) {
      const kind = m[1].replace(/\s+/g, " ").toUpperCase();
      ctx.add(
        "create-if-not-exists",
        `CREATE ${kind} must use IF NOT EXISTS.`,
        `Write CREATE ${kind} IF NOT EXISTS so a retried migration is a no-op.`,
        line
      );
    }
    return { concurrently };
  }

  if ((m = CREATE_REPLACEABLE_RE.exec(norm))) {
    if (!m[1]) {
      const kind = m[2].toUpperCase();
      ctx.add(
        "create-or-replace",
        `CREATE ${kind} must use OR REPLACE.`,
        `Write CREATE OR REPLACE ${kind} so a retried migration is a no-op.`,
        line
      );
    }
    return { concurrently };
  }

  if ((m = CREATE_UNGUARDABLE_RE.exec(norm))) {
    ctx.add(
      "create-type-guarded",
      `Bare CREATE ${m[1].toUpperCase()} is not idempotent.`,
      DO_BLOCK_HINT,
      line
    );
    return { concurrently };
  }

  const masked = maskLiterals(norm);

  if (ALTER_INDEX_ATTACH_RE.test(masked)) {
    ctx.add(
      "alter-action-guarded",
      "ALTER INDEX ... ATTACH PARTITION is not idempotent.",
      "A second run fails because the partition index is already attached. Wrap it in a DO $$ ... $$ block that " +
        "checks pg_inherits first.",
      line
    );
    return { concurrently };
  }

  if ((m = RENAME_OBJECT_RE.exec(masked))) {
    ctx.add(
      "rename-guarded",
      `ALTER ${m[1].toUpperCase()} ... RENAME is not idempotent.`,
      RENAME_HINT,
      line
    );
    return { concurrently };
  }

  const commandAt = leadingCteOffset(masked);
  if (INSERT_RE.test(norm.slice(commandAt))) {
    const command = masked.slice(commandAt);
    if (!ON_CONFLICT_RE.test(command) && !/\bWHERE\s+NOT\s+EXISTS\s*\(/i.test(command)) {
      ctx.add(
        "insert-on-conflict",
        "INSERT without ON CONFLICT is not idempotent.",
        "Add ON CONFLICT DO NOTHING (or DO UPDATE), or a WHERE NOT EXISTS (...) guard, so a re-run does not duplicate or fail on the rows it already wrote.",
        line
      );
    }
    return { concurrently };
  }

  if ((m = ALTER_TYPE_ADD_VALUE_RE.exec(norm))) {
    if (!m[1]) {
      ctx.add(
        "add-value-if-not-exists",
        "ALTER TYPE ... ADD VALUE must use IF NOT EXISTS.",
        "Write ALTER TYPE \"Enum\" ADD VALUE IF NOT EXISTS 'VALUE'.",
        line
      );
    }
    return { concurrently };
  }

  if ((m = ALTER_TABLE_RE.exec(raw))) {
    const table = normalize(m[1]);
    const body = m[2];
    const bodyStart = m[0].length - body.length;
    const actions = splitActions(body);
    const droppedIfExists = new Set<string>();
    for (const action of actions) {
      const dm = DROP_CONSTRAINT_IF_EXISTS_RE.exec(normalize(action.text));
      if (dm) droppedIfExists.add(unquote(dm[1]));
    }
    for (const action of actions) {
      const text = normalize(action.text);
      const actionLine = line + countLines(raw.slice(0, bodyStart + action.offset));
      let am: RegExpExecArray | null;
      if (RENAME_ACTION_RE.test(text)) {
        ctx.add(
          "rename-guarded",
          `ALTER TABLE ... RENAME is not idempotent.`,
          RENAME_HINT,
          actionLine
        );
        continue;
      }
      if ((am = UNGUARDABLE_ACTION_RE.exec(text))) {
        const action = am[1].replace(/\s+/g, " ").toUpperCase();
        ctx.add(
          "alter-action-guarded",
          `${action} on ${table} is not idempotent.`,
          "A second run fails because the change is already in place (or the object has moved). Wrap it in a DO $$ ... $$ " +
            "block that checks the catalog first (pg_inherits for partitions and inheritance, pg_namespace for the schema).",
          actionLine
        );
        continue;
      }
      if (
        (am = ADD_NAMED_CONSTRAINT_RE.exec(text)) &&
        droppedIfExists.has(unquote(am[1])) &&
        ctx.createdTables.has(tableKey(table))
      ) {
        continue;
      }
      if (ADD_CONSTRAINT_RE.test(text)) {
        ctx.add(
          "add-constraint-guarded",
          `Bare ADD CONSTRAINT on ${table} is not idempotent.`,
          DO_BLOCK_HINT +
            ' On a table created in this same file, DROP CONSTRAINT IF EXISTS "name", ADD CONSTRAINT "name" ... ' +
            "in one statement is also accepted (on an existing table that would rebuild the constraint under lock on every run).",
          actionLine
        );
        continue;
      }
      if ((am = ADD_COLUMN_RE.exec(text))) {
        if (!am[1]) {
          ctx.add(
            "add-column-if-not-exists",
            `ADD COLUMN ${am[2]} on ${table} must use IF NOT EXISTS.`,
            'Write ALTER TABLE ... ADD COLUMN IF NOT EXISTS "column" ... so a retried migration is a no-op.',
            actionLine
          );
        }
        continue;
      }
      if ((am = DROP_ACTION_RE.exec(text))) {
        if (!am[2]) {
          const what = (am[1] ?? "COLUMN").toUpperCase();
          ctx.add(
            "drop-if-exists",
            `DROP ${what} ${am[3]} on ${table} must use IF EXISTS.`,
            `Write ALTER TABLE ... DROP ${what} IF EXISTS ${am[3]} so a retried migration is a no-op.`,
            actionLine
          );
        }
      }
    }
    return { concurrently };
  }

  if ((m = DROP_RE.exec(norm))) {
    const kind = m[1].replace(/\s+/g, " ").toUpperCase();
    concurrently = Boolean(m[2]);
    if (!m[3]) {
      ctx.add(
        "drop-if-exists",
        `DROP ${kind} must use IF EXISTS.`,
        `Write DROP ${kind}${kind === "INDEX" ? " CONCURRENTLY" : ""} IF EXISTS so a retried migration is a no-op.`,
        line
      );
    }
    if (kind === "INDEX" && !concurrently) {
      ctx.add(
        "drop-index-concurrently",
        "DROP INDEX must use CONCURRENTLY.",
        "A plain DROP INDEX takes an ACCESS EXCLUSIVE lock on the table. Use DROP INDEX CONCURRENTLY IF EXISTS " +
          "in its own migration file. Postgres cannot drop a partitioned index concurrently; for those, keep the plain " +
          "form and add a migration-guard: allow directive saying so.",
        line
      );
    }
    return { concurrently };
  }

  if (/^CREATE\b/i.test(norm)) {
    ctx.add(
      "create-unrecognized",
      "CREATE statement of a kind the guard does not recognise.",
      "Check by hand that it is safe to re-run, then add a `-- migration-guard: allow <reason>` directive, or extend the guard.",
      line
    );
  }

  return { concurrently };
}

/** Checks one migration file's SQL and returns every unsuppressed violation. */
export function checkMigration(source: string): CheckResult {
  const { statements, unattachedAllows } = parseMigration(source);
  const createdTables = new Set<string>();
  for (const s of statements) {
    const body = /^DO\b/i.test(s.sql) ? doBody(s.sql)?.body : undefined;
    if (body === null) continue;
    for (const key of findCreatedTables(normalize(body ?? s.sql))) createdTables.add(key);
  }

  const violations: Violation[] = [];
  let suppressed = 0;
  const suppress = (count: number) => {
    suppressed += count;
  };
  const root = collect(violations, "", createdTables, suppress);

  for (const statement of statements) {
    const excerptText = excerpt(normalize(statement.sql));
    const own: Violation[] = [];
    const ctx = collect(own, excerptText, createdTables, suppress);

    const { concurrently } = checkStatement(statement.sql, statement.line, ctx);

    if (concurrently && statements.length > 1) {
      own.push({
        line: statement.line,
        rule: "concurrently-single-statement",
        message: `CONCURRENTLY used in a file with ${statements.length} statements.`,
        hint: CONCURRENTLY_HINT,
        statement: excerptText,
      });
    }

    applyAllow(statement.allow, own, root);
  }

  for (const allow of unattachedAllows) {
    root.add(
      "allow-unused",
      "migration-guard: allow is not attached to any statement.",
      "Each statement takes one directive, on the line above it or trailing it on the same line. Remove stacked or stray directives.",
      allow.line
    );
  }

  violations.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return { violations, suppressed };
}

function excerpt(norm: string): string {
  return norm.length > 120 ? `${norm.slice(0, 117)}...` : norm;
}
