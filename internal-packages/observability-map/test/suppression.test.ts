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
});
