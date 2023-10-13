import crypto from "node:crypto";

export function generateSecret(sizeInBytes = 32): string {
  return crypto.randomBytes(sizeInBytes).toString("hex");
}
