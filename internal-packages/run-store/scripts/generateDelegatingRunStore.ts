// One-off generator for the RunStore pass-through base.
//
// The base class is mechanical: 80-odd near-identical forwarders. Generating it removes the chance
// of a hand-typo that no test would catch, and turns "did we miss a method" into a diff rather than
// a review. Re-run after any change to the RunStore interface:
//
//   pnpm exec tsx scripts/generateDelegatingRunStore.ts
//
// The interface is scanned directly rather than through the TypeScript compiler API, because
// `require("typescript")` resolves to a stub in this workspace.
//
// A parsing miss cannot pass silently, but NOT because of the runtime suite: that compares the class
// against the name list, and both come from this one parse, so a miss drops the member from both
// sides and the comparison still holds. Two compile-time checks catch it instead:
//
//   - `implements RunStore` on the generated class fails with TS2420 when a member is absent.
//   - The assertions emitted into runStoreMethodNames.ts tie the name lists to `keyof RunStore`,
//     in both directions, so a dropped or invented name fails typecheck.
//
// Those live in src rather than in a test because tsconfig.build.json excludes test files, so a
// type-level assertion written in a test is never checked by CI.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/types.ts"), "utf8");

/** Replaces every comment and string body with spaces, so a brace inside one cannot move the depth. */
function blankCommentsAndStrings(text: string): string {
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
      while (j < text.length && text[j] !== quote) {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += quote + " ".repeat(Math.max(0, j - i - 1)) + (text[j] ?? "");
      i = j + 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

const blanked = blankCommentsAndStrings(source);

const declaration = "export interface RunStore {";
const start = blanked.indexOf(declaration);
if (start === -1) {
  throw new Error("export interface RunStore not found in src/types.ts");
}

const bodyStart = start + declaration.length;
let depth = 1;
let bodyEnd = bodyStart;
while (bodyEnd < blanked.length && depth > 0) {
  const ch = blanked[bodyEnd];
  if (ch === "{") depth += 1;
  else if (ch === "}") depth -= 1;
  if (depth > 0) bodyEnd += 1;
}
if (depth !== 0) {
  throw new Error("unbalanced braces while reading the RunStore interface body");
}

const body = blanked.slice(bodyStart, bodyEnd);

// Members are separated by `;` at nesting depth 0. Only `{}`, `()` and `[]` count towards depth:
// angle brackets cannot, because `=>` in a callback parameter type carries an unmatched `>`.
function splitMembers(text: string): { offset: number; length: number }[] {
  const spans: { offset: number; length: number }[] = [];
  let level = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") level += 1;
    else if (ch === "}" || ch === ")" || ch === "]") level -= 1;
    else if (ch === ";" && level === 0) {
      spans.push({ offset: from, length: i - from });
      from = i + 1;
    }
  }
  if (text.slice(from).trim().length > 0) {
    spans.push({ offset: from, length: text.length - from });
  }
  return spans;
}

const methods: string[] = [];
const readonlyProperties: { name: string; type: string }[] = [];
const mutableProperties: string[] = [];

for (const span of splitMembers(body)) {
  const blankedMember = body.slice(span.offset, span.offset + span.length).trim();
  if (blankedMember.length === 0) continue;

  // A method: an optional name then `(` or `<`. A property: a name then `:`.
  const asMethod = /^([A-Za-z_$][\w$]*)\s*\??\s*[(<]/.exec(blankedMember);
  if (asMethod) {
    methods.push(asMethod[1]);
    continue;
  }

  const asProperty = /^(readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*:([\s\S]*)$/.exec(blankedMember);
  if (asProperty) {
    const [, isReadonly, name, , type] = asProperty;
    if (isReadonly) {
      readonlyProperties.push({ name, type: type.trim() });
    } else {
      mutableProperties.push(name);
    }
    continue;
  }

  throw new Error(`could not classify a RunStore member: ${blankedMember.slice(0, 80)}`);
}

if (mutableProperties.length > 0) {
  // A writable data property cannot be forwarded by a getter alone, so the base would silently hold
  // its own copy instead of the delegate's. Handle it by hand before regenerating.
  throw new Error(
    `RunStore declares writable data properties the generator cannot forward: ${mutableProperties.join(", ")}`
  );
}

const unique = [...new Set(methods)];
if (unique.length === 0) {
  throw new Error("RunStore declares no methods, which cannot be right");
}

const memberNames = [...unique, ...readonlyProperties.map((p) => p.name)];

const header = `// GENERATED by scripts/generateDelegatingRunStore.ts. Do not edit by hand.
// Regenerate after any change to the RunStore interface:
//   pnpm exec tsx scripts/generateDelegatingRunStore.ts
`;

writeFileSync(
  join(root, "src/runStoreMethodNames.ts"),
  `${header}
import type { RunStore } from "./types.js";

// Every method the RunStore interface declares. The forwarding probe enumerates this to drive one
// call per member; member PRESENCE is proved by the compiler, in the assertions at the foot of this
// file and by \`implements RunStore\` on the generated class.
export const RUN_STORE_METHOD_NAMES = [
${unique.map((n) => `  "${n}",`).join("\n")}
] as const;

// Data properties the base exposes as getters over the delegate, not as forwarders.
export const RUN_STORE_PROPERTY_NAMES = [
${readonlyProperties.map((p) => `  "${p.name}",`).join("\n")}
] as const;

// ---------------------------------------------------------------------------
// Parity with the interface, checked by the compiler.
//
// The lists above are produced by parsing types.ts. These assertions compare them
// against \`keyof RunStore\`, which the compiler derives from the interface itself,
// so a name this generator failed to parse, or invented, is a build failure rather
// than a silent gap. Both directions are checked: a missing name and an extra one.
// ---------------------------------------------------------------------------

type RunStoreMemberName =
  | (typeof RUN_STORE_METHOD_NAMES)[number]
  | (typeof RUN_STORE_PROPERTY_NAMES)[number];

/** Fails when the interface declares a member the generator did not emit. */
type _EveryInterfaceMemberIsListed = [Exclude<keyof RunStore, RunStoreMemberName>] extends [never]
  ? true
  : never;
const _everyInterfaceMemberIsListed: _EveryInterfaceMemberIsListed = true;
void _everyInterfaceMemberIsListed;

/** Fails when the generator emitted a name the interface does not declare. */
type _EveryListedNameIsOnTheInterface = [Exclude<RunStoreMemberName, keyof RunStore>] extends [never]
  ? true
  : never;
const _everyListedNameIsOnTheInterface: _EveryListedNameIsOnTheInterface = true;
void _everyListedNameIsOnTheInterface;
`
);

writeFileSync(
  join(root, "src/delegatingRunStore.ts"),
  `${header}
// A pass-through over another RunStore. It exists so a decorator can override the handful of methods
// it cares about and inherit the rest, instead of restating 80-odd forwarders alongside real logic.
//
// Arguments and return values are forwarded untouched. The \`any\` signatures carry each method's
// whole overload set through one forwarder, which is the single thing a generated base cannot
// preserve; a subclass that overrides a method restates the real signature there.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RunStore } from "./types.js";

export class DelegatingRunStore implements RunStore {
  constructor(protected readonly delegate: RunStore) {}

${readonlyProperties
  // Indexed access rather than the written type, so the getter needs no import of its own and
  // follows the interface if that type is ever changed.
  .map(
    (p) => `  get ${p.name}(): RunStore["${p.name}"] {\n    return this.delegate.${p.name};\n  }`
  )
  .join("\n\n")}${readonlyProperties.length > 0 ? "\n\n" : ""}${unique
    .map(
      (n) => `  ${n}(...args: any[]): any {\n    return (this.delegate as any).${n}(...args);\n  }`
    )
    .join("\n\n")}
}

// \`implements\` above fails when a member of the interface is MISSING here. It says nothing about a
// member that should not exist, so the reverse direction is asserted too: a public member this class
// declares and the interface does not is a build failure.
//
// \`protected delegate\` is correctly absent from \`keyof\`, so the constructor parameter does not
// trip this.
type _ClassDeclaresNoExtraMembers = [
  Exclude<keyof DelegatingRunStore, keyof RunStore>,
] extends [never]
  ? true
  : never;
const _classParity: _ClassDeclaresNoExtraMembers = true;
void _classParity;
`
);

console.log(
  `generated ${unique.length} forwarders and ${readonlyProperties.length} getters ` +
    `(${memberNames.length} members total)`
);
