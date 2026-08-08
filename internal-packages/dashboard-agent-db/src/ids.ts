import { randomInt } from "node:crypto";

// Same shape as the platform's `generateFriendlyId`, on `node:crypto` so this leaf
// package stays dependency-free.
const ALPHABET = "123456789abcdefghijkmnopqrstuvwxyz";
const SIZE = 21;

export function generateId(prefix: string, size: number = SIZE): string {
  let body = "";
  for (let i = 0; i < size; i++) {
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${prefix}_${body}`;
}

export const generateInvestigationId = () => generateId("inv");
export const generateWatchId = () => generateId("watch");
