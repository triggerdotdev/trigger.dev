import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { EncryptedValueSchema } from "~/utils/encryptionKeyring.server";

export const ENVIRONMENT_ENCRYPTION_SCHEME = "env-hkdf-aes-gcm-v1";
export const ENVIRONMENT_SECRET_VERSION = "environment-v1";
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const hex = (bytes: number) => z.string().regex(new RegExp(`^[a-f0-9]{${bytes * 2}}$`));

const EnvironmentEncryptedValueSchema = z
  .object({
    scheme: z.literal(ENVIRONMENT_ENCRYPTION_SCHEME),
    keyId: z.string().min(1),
    salt: hex(SALT_BYTES),
    nonce: hex(NONCE_BYTES),
    ciphertext: z.string().regex(/^(?:[a-f0-9]{2})*$/),
    tag: hex(TAG_BYTES),
  })
  .strict();
export const StoredEnvironmentValueSchema = z.union([
  EnvironmentEncryptedValueSchema,
  EncryptedValueSchema.extend({ scheme: z.never().optional() }),
]);
export type EnvironmentEncryptedValue = z.infer<typeof EnvironmentEncryptedValueSchema>;
export type StoredEnvironmentValue = z.infer<typeof StoredEnvironmentValueSchema>;

export function parseStoredEnvironmentValue(
  value: unknown,
  version?: string
): StoredEnvironmentValue | null {
  switch (version) {
    case "1":
      if (typeof value === "object" && value !== null && "scheme" in value)
        throw new Error("Invalid plaintext secret format");
      return null;
    case "2":
      return EncryptedValueSchema.parse(value);
    case ENVIRONMENT_SECRET_VERSION:
      return EnvironmentEncryptedValueSchema.parse(value);
    case undefined:
      return StoredEnvironmentValueSchema.parse(value);
    default:
      throw new Error("Unsupported environment secret version");
  }
}

export type ObjectContext = {
  environmentId: string;
  purpose: "environment-variable" | "build-env-vars";
  objectId: string;
};

function contextBytes(context: ObjectContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      ENVIRONMENT_ENCRYPTION_SCHEME,
      context.environmentId,
      context.purpose,
      context.objectId,
    ])
  );
}

function objectKey(key: Buffer, salt: Buffer, context: ObjectContext): Buffer {
  if (key.length !== KEY_BYTES) throw new Error("Invalid environment encryption key length");
  return Buffer.from(hkdfSync("sha256", key, salt, contextBytes(context), KEY_BYTES));
}

function aad(keyId: string, context: ObjectContext): Buffer {
  return Buffer.from(JSON.stringify([keyId, contextBytes(context).toString("utf8")]));
}

export function encryptEnvironmentValue(
  plaintext: string,
  keyId: string,
  key: Buffer,
  context: ObjectContext
): EnvironmentEncryptedValue {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const derived = objectKey(key, salt, context);
  try {
    const cipher = createCipheriv("aes-256-gcm", derived, nonce);
    cipher.setAAD(aad(keyId, context));
    return {
      scheme: ENVIRONMENT_ENCRYPTION_SCHEME,
      keyId,
      salt: salt.toString("hex"),
      nonce: nonce.toString("hex"),
      ciphertext: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
    };
  } finally {
    derived.fill(0);
  }
}

export function decryptEnvironmentValue(
  value: EnvironmentEncryptedValue,
  key: Buffer,
  context: ObjectContext
): string {
  const derived = objectKey(key, Buffer.from(value.salt, "hex"), context);
  try {
    const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(value.nonce, "hex"));
    decipher.setAAD(aad(value.keyId, context));
    decipher.setAuthTag(Buffer.from(value.tag, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } finally {
    derived.fill(0);
  }
}

export function wrappingContext(environmentId: string, keyId: string) {
  return { purpose: "trigger-environment-key-v1", environmentId, keyId };
}
