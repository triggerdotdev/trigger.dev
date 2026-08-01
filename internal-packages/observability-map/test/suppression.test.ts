import { suppressedChecks } from "../src/suppression.js";

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
  // check. Reading genuine comment ranges from the TypeScript scanner closes both shapes: the
  // scanner consumes a string or template literal as one token and never emits comment trivia for
  // what is inside it.
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
});
