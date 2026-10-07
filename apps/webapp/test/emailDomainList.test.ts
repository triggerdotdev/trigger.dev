import { describe, expect, it } from "vitest";
import { emailDomainIsListed } from "../app/utils/emailDomainList.js";

describe("emailDomainIsListed", () => {
  it("matches an address at a listed domain", () => {
    expect(emailDomainIsListed("blocked.example", "bot@blocked.example")).toBe(true);
  });

  it("matches subdomains of a listed domain", () => {
    expect(emailDomainIsListed("blocked.example", "bot@mail.blocked.example")).toBe(true);
    expect(emailDomainIsListed("blocked.example", "bot@a.b.blocked.example")).toBe(true);
  });

  it("ignores case and surrounding whitespace in both the list and the address", () => {
    expect(emailDomainIsListed("  Blocked.Example  ", "Bot@BLOCKED.example")).toBe(true);
  });

  it("accepts comma and whitespace separated lists", () => {
    const list = "one.example, two.example\nthree.example  four.example";
    expect(emailDomainIsListed(list, "a@one.example")).toBe(true);
    expect(emailDomainIsListed(list, "a@two.example")).toBe(true);
    expect(emailDomainIsListed(list, "a@three.example")).toBe(true);
    expect(emailDomainIsListed(list, "a@four.example")).toBe(true);
    expect(emailDomainIsListed(list, "a@five.example")).toBe(false);
  });

  it("accepts entries written with a leading @ or dot", () => {
    expect(emailDomainIsListed("@blocked.example", "bot@blocked.example")).toBe(true);
    expect(emailDomainIsListed(".blocked.example", "bot@sub.blocked.example")).toBe(true);
  });

  it("matches a fully qualified domain with a trailing dot", () => {
    expect(emailDomainIsListed("blocked.example", "bot@blocked.example.")).toBe(true);
  });

  it("does not match look-alike domains", () => {
    expect(emailDomainIsListed("blocked.example", "user@notblocked.example")).toBe(false);
    expect(emailDomainIsListed("blocked.example", "user@blocked.example.attacker.example")).toBe(
      false
    );
    expect(emailDomainIsListed("blocked.example", "blocked.example@other.example")).toBe(false);
  });

  it("does not let a listed domain block its parent", () => {
    expect(emailDomainIsListed("mail.company.example", "user@company.example")).toBe(false);
  });

  it("matches nothing when the list is empty or only separators", () => {
    expect(emailDomainIsListed("", "user@company.example")).toBe(false);
    expect(emailDomainIsListed(" , ,", "user@company.example")).toBe(false);
  });

  it("matches nothing for an address without a domain", () => {
    expect(emailDomainIsListed("blocked.example", "user@")).toBe(false);
  });
});
