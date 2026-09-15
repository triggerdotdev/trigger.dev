import { describe, expect, it } from "vitest";
import { emailMatchesPattern } from "../app/utils/emailPattern.js";

// emailMatchesPattern backs the ADMIN_EMAILS and WHITELISTED_EMAILS gates.
// Property under test: a pattern matches the whole address, never a substring.
describe("emailMatchesPattern", () => {
  it("matches an address that equals the operator pattern exactly", () => {
    expect(emailMatchesPattern("admin@company.com", "admin@company.com")).toBe(true);
  });

  it("matches a leading-@ domain shorthand against addresses at that domain", () => {
    expect(emailMatchesPattern("@company.com", "alice@company.com")).toBe(true);
    expect(emailMatchesPattern("@company.com", "bob@company.com")).toBe(true);
  });

  it("rejects a look-alike address that merely contains the pattern", () => {
    // A look-alike address embeds the pattern as a substring; an unanchored
    // match would wrongly accept it.
    expect(emailMatchesPattern("admin@company.com", "evil@admin@company.com.attacker.com")).toBe(
      false
    );
    expect(emailMatchesPattern("@company.com", "evil@company.com.attacker.com")).toBe(false);
    expect(emailMatchesPattern("@company.com", "alice@sub.company.com")).toBe(false);
  });

  it("rejects a trailing-garbage address (pattern is only a prefix)", () => {
    expect(emailMatchesPattern("admin@company.com", "admin@company.computer-evil.com")).toBe(false);
  });

  it("rejects a leading-garbage address (pattern is only a suffix)", () => {
    expect(emailMatchesPattern("admin@company.com", "not-admin@company.com")).toBe(false);
  });

  it("preserves top-level alternation as whole-string alternatives", () => {
    // Guards against anchoring without the non-capturing group, which would
    // turn `^a|b$` into anchored-a OR anchored-b and break multi-address configs.
    const pattern = "alice@x.com|bob@x.com";
    expect(emailMatchesPattern(pattern, "alice@x.com")).toBe(true);
    expect(emailMatchesPattern(pattern, "bob@x.com")).toBe(true);
    expect(emailMatchesPattern(pattern, "eve@x.com")).toBe(false);
    // ...and alternation must not become a substring match either.
    expect(emailMatchesPattern(pattern, "eve+alice@x.com.evil.com")).toBe(false);
  });

  it("expands domain shorthand inside simple top-level alternation", () => {
    const pattern = "alice@x.com|@company.com";
    expect(emailMatchesPattern(pattern, "alice@x.com")).toBe(true);
    expect(emailMatchesPattern(pattern, "carol@company.com")).toBe(true);
    expect(emailMatchesPattern(pattern, "carol@company.com.evil.com")).toBe(false);
  });

  it("accepts patterns that already carry their own anchors", () => {
    // Operators who already wrote a fully-anchored pattern keep working:
    // ^(?:^...$)$ accepts exactly the same strings.
    expect(emailMatchesPattern("^ops@company\\.com$", "ops@company.com")).toBe(true);
    expect(emailMatchesPattern("^ops@company\\.com$", "ops@company.com.evil.com")).toBe(false);
  });
});
