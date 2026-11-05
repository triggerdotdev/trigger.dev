import nodeCrypto from "node:crypto";
import { expect, it } from "vitest";
import {
  decryptValue,
  encryptValue,
  parseEncryptionKeyring,
  resolveEncryptionKeyring,
} from "~/utils/encryptionKeyring.server";

const A = "0123456789abcdef0123456789abcdef";
const B = "abcdef0123456789abcdef0123456789";
const config = (activeKeyId: string) => JSON.stringify({ activeKeyId, keys: { legacy: A, v2: B } });

// Catches: legacy ciphertext becoming unreadable, or untagged values trying non-legacy keys.
it("uses legacy for untagged ciphertext, never the active key", () => {
  const nonce = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", A, nonce);
  const ciphertext = cipher.update("secret", "utf8", "hex") + cipher.final("hex");
  const old = {
    nonce: nonce.toString("hex"),
    ciphertext,
    tag: cipher.getAuthTag().toString("hex"),
  };
  const active = parseEncryptionKeyring(config("v2"));
  expect(decryptValue(old, active)).toBe("secret");
  const { keyId: _, ...untaggedB } = encryptValue("secret", active);
  expect(() => decryptValue(untaggedB, active)).toThrow();
});

// Catches: preloaded and activated processes failing to read each other's tagged writes.
it("normalizes the fallback and supports A+B preload before B activation", () => {
  const fallback = resolveEncryptionKeyring(undefined, A);
  const preloaded = parseEncryptionKeyring(config("legacy"));
  const active = parseEncryptionKeyring(config("v2"));
  expect(decryptValue(encryptValue("secret", fallback), active)).toBe("secret");
  expect(decryptValue(encryptValue("secret", active), preloaded)).toBe("secret");
  expect(() =>
    decryptValue({ ...encryptValue("secret", active), keyId: "missing" }, active)
  ).toThrow("Unknown encryption key ID");
});

// Catches: startup accepting malformed configuration, missing active keys or a mis-copied legacy key.
it("rejects invalid keyring configuration", () => {
  for (const value of [
    "not JSON",
    "{}",
    JSON.stringify({ activeKeyId: "missing", keys: { legacy: A } }),
    JSON.stringify({ activeKeyId: "legacy", keys: { legacy: "short" } }),
  ]) {
    expect(() => parseEncryptionKeyring(value)).toThrow("ENCRYPTION_KEYRING");
  }
  expect(() => resolveEncryptionKeyring(parseEncryptionKeyring(config("v2")), B)).toThrow(
    "legacy key must match"
  );
});
