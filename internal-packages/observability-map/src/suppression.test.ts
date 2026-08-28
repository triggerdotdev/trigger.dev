import { parseSuppressions, suppressedChecks } from "./suppression.js";

describe("suppressedChecks", () => {
  it("reads a suppression with its reason", () => {
    const m = suppressedChecks(
      `// obs-map-disable error-classification -- liveness probe, deliberately silent
       export async function loader() { return { ok: true }; }`
    );
    expect(m.get("error-classification")).toBe("liveness probe, deliberately silent");
  });

  it("ignores a suppression with no reason", () => {
    const m = suppressedChecks(`// obs-map-disable error-classification`);
    expect(m.size).toBe(0);
  });

  it("ignores a suppression whose reason is only whitespace", () => {
    const m = suppressedChecks(`// obs-map-disable error-classification --    `);
    expect(m.size).toBe(0);
  });

  it("reads several suppressions in one file", () => {
    const m = suppressedChecks(
      `// obs-map-disable error-classification -- liveness probe
       // obs-map-disable request-context -- no identifiers exist here
       export async function loader() { return { ok: true }; }`
    );
    expect(m.size).toBe(2);
    expect(m.get("error-classification")).toBe("liveness probe");
    expect(m.get("request-context")).toBe("no identifiers exist here");
  });

  it("returns nothing for a file with no suppressions", () => {
    expect(suppressedChecks(`export async function loader() { return 1; }`).size).toBe(0);
  });

  it("does not carry a reason across lines", () => {
    const m = suppressedChecks(
      `// obs-map-disable error-classification
       // some other comment -- with a dash
       export async function loader() { return 1; }`
    );
    expect(m.size).toBe(0);
  });

  // I2. The directive is a comment directive. Matching it file-wide meant a string literal that
  // merely quotes it, in a test fixture or an error message, silently suppressed a real check.
  it("ignores the directive inside a string literal", () => {
    const m = suppressedChecks(
      `const example = "obs-map-disable error-classification -- not a real suppression";
       export async function loader() { return 1; }`
    );
    expect(m.size).toBe(0);
  });

  it("reads the directive from a block comment", () => {
    const m = suppressedChecks(
      `/* obs-map-disable auth-boundary -- public by design, see ADR 12 */
       export async function loader() { return 1; }`
    );
    expect(m.get("auth-boundary")).toBe("public by design, see ADR 12");
  });

  it("reads the directive from a jsdoc line", () => {
    const m = suppressedChecks(
      `/**
        * obs-map-disable request-context -- nothing tenant-scoped here
        */
       export async function loader() { return 1; }`
    );
    expect(m.get("request-context")).toBe("nothing tenant-scoped here");
  });

  it("ignores code that happens to follow a comment on the same line", () => {
    const m = suppressedChecks(
      `const x = 1; // obs-map-disable error-classification -- fine
       export async function loader() { return x; }`
    );
    expect(m.get("error-classification")).toBe("fine");
  });

  // The directive was called `-next-line` while applying to the whole entry point, so a comment on
  // the last line of a file switched a check off for everything above it. Renamed rather than
  // scoped, because a finding has no line number to scope it to. The old spelling is not honoured.
  it("does not honour the old -next-line spelling", () => {
    const m = suppressedChecks(
      `// obs-map-disable-next-line error-classification -- stale directive
       export async function loader() { return 1; }`
    );
    expect(m.size).toBe(0);
  });

  // A2. `indexOf("//")` against the raw text found the marker inside a string literal too, so a
  // string that merely quotes the directive granted a suppression nobody wrote and silenced a real
  // check. Reading comment ranges off the parsed source closes this: a string literal is one node
  // with its own span, never trivia, so a directive inside it is content, not a comment.
  it("does not suppress from a directive quoted inside a string literal", () => {
    const m = suppressedChecks(
      `const msg = "see // obs-map-disable error-classification -- because reasons";
       export async function loader() { return 1; }`
    );
    expect(m.size).toBe(0);
  });

  it("does not suppress from a directive quoted inside a string with no real comment marker", () => {
    const m = suppressedChecks(
      `const u = "https://example.com obs-map-disable auth-boundary -- nope";
       export async function loader() { return 1; }`
    );
    expect(m.size).toBe(0);
  });

  it("does not suppress from a directive inside a template literal", () => {
    const m = suppressedChecks(
      "const msg = `see // obs-map-disable error-classification -- template literal`;\n" +
        "export async function loader() { return 1; }"
    );
    expect(m.size).toBe(0);
  });

  // A standalone `ts.createScanner` has no parser state, so it granted two suppressions nobody wrote:
  // it never rescans a template as a continuation after a substitution, and it has no JSX context.
  it("does not suppress from a directive after a template substitution", () => {
    const m = suppressedChecks(
      "const msg = `${name} // obs-map-disable error-classification -- via substitution`;\n" +
        "export async function loader() { return 1; }"
    );
    expect(m.size).toBe(0);
  });

  it("does not suppress from a directive inside JSX text", () => {
    const m = suppressedChecks(
      `export default function Page() {
         return <p>docs at https://example.com obs-map-disable error-classification -- x</p>;
       }`,
      "route.tsx"
    );
    expect(m.size).toBe(0);
  });

  // The case above passes without any JSX handling, because the lexers only find a comment at the
  // exact offset they are asked about. These four are the shapes that needed the fix, JSX text that
  // BEGINS with a marker, and removing `ts.isJsxText` fails all four and nothing else in the suite.
  describe("jsx text is content, not a comment", () => {
    const page = (body: string) => `const name = "x";
       export default function Page() {
         return ${body};
       }`;

    it("does not suppress from JSX text beginning with a line comment marker", () => {
      const m = suppressedChecks(
        page(`<p>// obs-map-disable error-classification -- jsx line</p>`),
        "route.tsx"
      );
      expect(m.size).toBe(0);
    });

    it("does not suppress from JSX text beginning with a block comment marker", () => {
      const m = suppressedChecks(
        page(`<p>/* obs-map-disable audit-trail -- jsx block */</p>`),
        "route.tsx"
      );
      expect(m.size).toBe(0);
    });

    it("does not suppress from JSX text starting right after an expression container", () => {
      const m = suppressedChecks(
        page(`<p>{name}// obs-map-disable request-context -- after expression</p>`),
        "route.tsx"
      );
      expect(m.size).toBe(0);
    });

    // A fourth input, exercising the same mechanism at a different tree position: the text is not
    // the first child of the outermost element, so the token boundary the lexer is pointed at is a
    // different one again.
    it("does not suppress from JSX text nested several elements deep", () => {
      const m = suppressedChecks(
        page(`<div><span><b>// obs-map-disable auth-boundary -- nested jsx</b></span></div>`),
        "route.tsx"
      );
      expect(m.size).toBe(0);
    });

    // Positive control for the same code path: a real comment inside a JSX expression container is
    // not JSX text and must survive. A filter that dropped it would pass every test above for the
    // wrong reason.
    it("still reads a directive from a comment in a JSX expression container", () => {
      const m = suppressedChecks(
        page(`<p>{/* obs-map-disable audit-trail -- real comment */}</p>`),
        "route.tsx"
      );
      expect(m.get("audit-trail")).toBe("real comment");
    });
  });

  // Extra inputs beyond the brief's two, exercising the same "not a real parse position" mechanism
  // differently: a second substitution, and a string literal nested inside a JSX expression
  // container, which is a different node kind again from either hole above.
  it("does not suppress from a directive after a second template substitution", () => {
    const m = suppressedChecks(
      "const msg = `${a}${b} // obs-map-disable auth-boundary -- nested substitution`;\n" +
        "export async function loader() { return 1; }"
    );
    expect(m.size).toBe(0);
  });

  it("does not suppress from a directive inside a string literal nested in a JSX expression container", () => {
    const m = suppressedChecks(
      `export default function Page() {
         return <p>{"see // obs-map-disable request-context -- nested string"}</p>;
       }`,
      "route.tsx"
    );
    expect(m.size).toBe(0);
  });

  // Positive control: a genuine directive still works in a .tsx file, and a directive after a
  // template with no substitution (already covered above) is not the only shape that must survive.
  it("still reads a genuine directive in a .tsx file", () => {
    const m = suppressedChecks(
      `// obs-map-disable error-classification -- liveness probe
       export default function Page() { return <p>hi</p>; }`,
      "route.tsx"
    );
    expect(m.get("error-classification")).toBe("liveness probe");
  });

  // Regression control: a generic arrow function is only unambiguous when the file is parsed as
  // plain TypeScript, not TSX (`<T>` would otherwise start a JSX element). A .ts file must still
  // parse sanely and keep reading a genuine trailing comment correctly.
  it("still reads a genuine directive beside a generic arrow function in a .ts file", () => {
    const m = suppressedChecks(
      "const identity = <T,>(x: T): T => x; // obs-map-disable auth-boundary -- generic helper\n" +
        "export async function loader() { return identity(1); }"
    );
    expect(m.get("auth-boundary")).toBe("generic helper");
  });
});

// B6. `// obs-map-disable eror-classification -- typo` used to parse, land in the map, match no
// check and appear nowhere, so the author read the finding as acknowledged.
describe("a suppression naming a check that does not exist", () => {
  it("suppresses nothing and is reported as unknown", () => {
    const r = parseSuppressions(
      `// obs-map-disable eror-classification -- typo
       export async function loader() { return 1; }`
    );
    expect(r.byId.size).toBe(0);
    expect(r.unknown).toEqual(["eror-classification"]);
  });

  it("does not swallow the real suppressions beside it", () => {
    const r = parseSuppressions(
      `// obs-map-disable auth-boundry -- typo
       // obs-map-disable auth-boundary -- public by design
       export async function loader() { return 1; }`
    );
    expect(r.byId.get("auth-boundary")).toBe("public by design");
    expect(r.unknown).toEqual(["auth-boundry"]);
  });

  it("reports each unknown id once however many times it appears", () => {
    const r = parseSuppressions(
      `// obs-map-disable request-contex -- typo
       /* obs-map-disable request-contex -- typo again */
       // obs-map-disable audit-trial -- another typo
       export async function loader() { return 1; }`
    );
    expect(r.unknown).toEqual(["request-contex", "audit-trial"]);
  });

  it("is not reported when the directive had no reason, since it was never a suppression", () => {
    const r = parseSuppressions(
      `// obs-map-disable eror-classification
       export async function loader() { return 1; }`
    );
    expect(r.unknown).toEqual([]);
  });

  it("is not read out of a string literal any more than a real one is", () => {
    const r = parseSuppressions(
      `const help = "// obs-map-disable eror-classification -- typo";
       export async function loader() { return help; }`
    );
    expect(r.unknown).toEqual([]);
  });

  it("keeps suppressedChecks returning only the ids that name a check", () => {
    const m = suppressedChecks(
      `// obs-map-disable eror-classification -- typo
       export async function loader() { return 1; }`
    );
    expect(m.size).toBe(0);
  });
});
