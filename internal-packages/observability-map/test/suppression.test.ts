import { suppressedChecks } from "../src/suppression.js";

describe("suppressedChecks", () => {
  it("reads a suppression with its reason", () => {
    const m = suppressedChecks(
      `// obs-map-disable-next-line error-classification -- liveness probe, deliberately silent
       export async function loader() { return { ok: true }; }`
    );
    expect(m.get("error-classification")).toBe("liveness probe, deliberately silent");
  });

  it("ignores a suppression with no reason", () => {
    const m = suppressedChecks(`// obs-map-disable-next-line error-classification`);
    expect(m.size).toBe(0);
  });

  it("ignores a suppression whose reason is only whitespace", () => {
    const m = suppressedChecks(`// obs-map-disable-next-line error-classification --    `);
    expect(m.size).toBe(0);
  });

  it("reads several suppressions in one file", () => {
    const m = suppressedChecks(
      `// obs-map-disable-next-line error-classification -- liveness probe
       // obs-map-disable-next-line request-context -- no identifiers exist here
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
      `// obs-map-disable-next-line error-classification
       // some other comment -- with a dash
       export async function loader() { return 1; }`
    );
    expect(m.size).toBe(0);
  });

  // I2. The directive is a comment directive. Matching it file-wide meant a string literal that
  // merely quotes it, in a test fixture or an error message, silently suppressed a real check.
  it("ignores the directive inside a string literal", () => {
    const m = suppressedChecks(
      `const example = "obs-map-disable-next-line error-classification -- not a real suppression";
       export async function loader() { return 1; }`
    );
    expect(m.size).toBe(0);
  });

  it("reads the directive from a block comment", () => {
    const m = suppressedChecks(
      `/* obs-map-disable-next-line auth-boundary -- public by design, see ADR 12 */
       export async function loader() { return 1; }`
    );
    expect(m.get("auth-boundary")).toBe("public by design, see ADR 12");
  });

  it("reads the directive from a jsdoc line", () => {
    const m = suppressedChecks(
      `/**
        * obs-map-disable-next-line request-context -- nothing tenant-scoped here
        */
       export async function loader() { return 1; }`
    );
    expect(m.get("request-context")).toBe("nothing tenant-scoped here");
  });

  it("ignores code that happens to follow a comment on the same line", () => {
    const m = suppressedChecks(
      `const x = 1; // obs-map-disable-next-line error-classification -- fine
       export async function loader() { return x; }`
    );
    expect(m.get("error-classification")).toBe("fine");
  });
});
