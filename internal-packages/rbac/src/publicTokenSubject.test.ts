import { describe, expect, it } from "vitest";
import { sourcePersonalAccessTokenClaim } from "./personalAccessTokenExpiry.js";
import {
  createPublicTokenSubjectCodec,
  createSourcePersonalAccessTokenCodec,
} from "./publicTokenSubject.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const PAT_ID = "cmpat0000000000000000000001";

describe("the source PAT codec", () => {
  /** Catches: the raw PAT id showing up in a public token. */
  it("seals the id and opens it again", () => {
    const codec = createSourcePersonalAccessTokenCodec(SECRET);

    const sealed = codec.encode(PAT_ID);

    expect(sealed.startsWith("pat_v1_")).toBe(true);
    expect(sealed).not.toContain(PAT_ID);
    expect(codec.decode(sealed)).toBe(PAT_ID);
  });

  /** Catches: a sealed PAT opening as an environment subject, or the reverse. */
  it("doesn't open values sealed for subjects, and subjects don't open its values", () => {
    const sourcePats = createSourcePersonalAccessTokenCodec(SECRET);
    const subjects = createPublicTokenSubjectCodec(SECRET);

    expect(sourcePats.decode(subjects.encode(PAT_ID))).toBeUndefined();
    expect(subjects.decode(sourcePats.encode(PAT_ID))).toBeUndefined();
  });

  /** Catches: a value sealed under another key, or altered, opening. */
  it("doesn't open a value sealed under another key or altered", () => {
    const codec = createSourcePersonalAccessTokenCodec(SECRET);
    const sealed = codec.encode(PAT_ID);
    const altered = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;

    expect(
      codec.decode(createSourcePersonalAccessTokenCodec("another-secret").encode(PAT_ID))
    ).toBe(undefined);
    expect(codec.decode(altered)).toBeUndefined();
  });
});

describe("sourcePersonalAccessTokenClaim", () => {
  const codec = createSourcePersonalAccessTokenCodec(SECRET);

  /** Catches: tokens without a source PAT being treated as having one. */
  it("is undefined when the token names no source PAT", () => {
    expect(sourcePersonalAccessTokenClaim({}, codec)).toBeUndefined();
    expect(sourcePersonalAccessTokenClaim({ act: { sub: "usr_1" } }, codec)).toBeUndefined();
    expect(sourcePersonalAccessTokenClaim({ act: "usr_1" }, codec)).toBeUndefined();
    expect(sourcePersonalAccessTokenClaim({ act: { pat: 42 } }, codec)).toBeUndefined();
  });

  it("opens a sealed source PAT", () => {
    const sealed = codec.encode(PAT_ID);

    expect(sourcePersonalAccessTokenClaim({ act: { pat: sealed } }, codec)).toEqual({
      sealed,
      id: PAT_ID,
    });
  });

  /** Catches: a raw or foreign `act.pat` being looked up (or skipped) instead of failing closed. */
  it("has no id when the claim doesn't open", () => {
    expect(sourcePersonalAccessTokenClaim({ act: { pat: PAT_ID } }, codec)).toEqual({
      sealed: PAT_ID,
      id: undefined,
    });
    expect(
      sourcePersonalAccessTokenClaim({ act: { pat: codec.encode(PAT_ID) } }, undefined)
    ).toMatchObject({ id: undefined });
  });
});
