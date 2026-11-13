import nodeCrypto from "node:crypto";
import { z } from "zod";

// ponytail: Mirrored in webapp and billing until billing can share a workspace crypto utility.
const LEGACY_KEY_ID = "legacy";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export const EncryptedValueSchema = z.object({
  scheme: z.never().optional(),
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
  keyId: z.string().min(1).optional(),
});

export type EncryptedValue = z.infer<typeof EncryptedValueSchema>;
export type EncryptionKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, string>;
};

const KeyringSchema = z.object({
  activeKeyId: z.string().min(1),
  keys: z.record(
    z.string().min(1),
    z.string().refine((key) => Buffer.byteLength(key, "utf8") === KEY_BYTES)
  ),
});

export function parseEncryptionKeyring(serialized: string): EncryptionKeyring {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("ENCRYPTION_KEYRING must be valid JSON");
  }

  const result = KeyringSchema.safeParse(value);
  if (!result.success) {
    throw new Error("ENCRYPTION_KEYRING requires activeKeyId and a map of 32-byte keys");
  }

  const keys = new Map(Object.entries(result.data.keys));
  if (!keys.has(result.data.activeKeyId)) {
    throw new Error("ENCRYPTION_KEYRING activeKeyId must identify a configured key");
  }

  return { activeKeyId: result.data.activeKeyId, keys };
}

export function resolveEncryptionKeyring(
  configured: EncryptionKeyring | undefined,
  legacyKey: string
): EncryptionKeyring {
  const keyring = configured ?? {
    activeKeyId: LEGACY_KEY_ID,
    keys: new Map([[LEGACY_KEY_ID, legacyKey]]),
  };
  const configuredLegacy = keyring.keys.get(LEGACY_KEY_ID);
  if (configuredLegacy !== undefined && configuredLegacy !== legacyKey) {
    throw new Error("ENCRYPTION_KEYRING legacy key must match ENCRYPTION_KEY");
  }
  return keyring;
}

export function encryptValue(value: string, keys: EncryptionKeyring): EncryptedValue {
  const keyId = keys.activeKeyId;
  const key = keys.keys.get(keyId);
  if (key === undefined) throw new Error(`Unknown encryption key ID: ${keyId}`);

  const nonce = nodeCrypto.randomBytes(NONCE_BYTES);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = cipher.update(value, "utf8", "hex") + cipher.final("hex");
  return {
    keyId,
    nonce: nonce.toString("hex"),
    ciphertext,
    tag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptValue(value: EncryptedValue, keys: EncryptionKeyring): string {
  const keyId = value.keyId ?? LEGACY_KEY_ID;
  const key = keys.keys.get(keyId);
  if (key === undefined) throw new Error(`Unknown encryption key ID: ${keyId}`);

  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "hex"));
  decipher.setAuthTag(Buffer.from(value.tag, "hex"));
  return decipher.update(value.ciphertext, "hex", "utf8") + decipher.final("utf8");
}
