import { randomBytes } from "node:crypto";

export function fenceUntrusted(text: string, source: string): string {
  const boundary = randomBytes(12).toString("hex");
  const safeSource = source.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const escaped = text.replace(/<\s*\/\s*(untrusted-data)/gi, "<\\/$1");
  return `<untrusted-data source="${safeSource}" boundary="${boundary}">${escaped}</untrusted-data boundary="${boundary}">`;
}
