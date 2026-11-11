import nodeCrypto from "node:crypto";
import {
  decryptValue,
  encryptValue,
  type EncryptedValue,
  type EncryptionKeyring,
} from "./encryptionKeyring.server";

export function encryptToken(value: string, keys: EncryptionKeyring): EncryptedValue {
  return encryptValue(value, keys);
}

export function decryptToken(value: EncryptedValue, keys: EncryptionKeyring): string {
  return decryptValue(value, keys);
}

export function hashToken(token: string): string {
  const hash = nodeCrypto.createHash("sha256");
  hash.update(token);
  return hash.digest("hex");
}
