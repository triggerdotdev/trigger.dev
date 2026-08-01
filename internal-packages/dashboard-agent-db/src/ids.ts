import { randomInt } from "node:crypto";

/**
 * Friendly ids for rows this package creates itself (`inv_…`).
 *
 * Same shape as the platform's `generateFriendlyId` — `prefix_` + 21 chars of the
 * lowercase alphanumeric alphabet with look-alikes (`0`, `l`) removed — but
 * implemented on `node:crypto` so this leaf package stays dependency-free.
 */
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
