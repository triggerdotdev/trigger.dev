import crypto from "node:crypto";

export function generateSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}
