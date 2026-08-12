import { createHash, randomInt } from "node:crypto";

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

/**
 * The id of the investigation a consented watch opens, derived from the watch itself.
 *
 * The wake seeds the row and a later action revises it, in different runs with no
 * hand-off between them, so the id has to be a function of the watch — otherwise the
 * second lane can only guess, and guessing picks up the user's own open card. A watch
 * reaches exactly one terminal outcome, so the watch id alone is the whole key.
 */
export function watchInvestigationId(watchId: string): string {
  const digest = createHash("sha256")
    .update(`dashboard-agent:watch-investigation:${watchId}`)
    .digest();
  let body = "";
  for (let i = 0; i < SIZE; i++) body += ALPHABET[digest[i]! % ALPHABET.length];
  return `inv_${body}`;
}
export const generateWatchId = () => generateId("watch");
/** Fencing token for one wake-delivery claim. */
export const generateWatchDeliveryClaimId = () => generateId("wdc");
