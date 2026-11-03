import parseDuration from "parse-duration";

const DEFAULT_EXPIRY = "1h";
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;
// Preserve the mint routes' numeric convention: epoch timestamps above ~2001,
// relative seconds otherwise.
const EXPIRY_EPOCH_THRESHOLD_SECONDS = 1_000_000_000;

export function validateJwtExpiration(
  expirationTime: number | string | undefined,
  nowSec: number
): { expirationTime: number; error?: never } | { error: string; expirationTime?: never } {
  let expiresAt: number;
  if (typeof expirationTime === "number") {
    expiresAt =
      expirationTime > EXPIRY_EPOCH_THRESHOLD_SECONDS ? expirationTime : nowSec + expirationTime;
  } else {
    const durationMs = parseDuration(expirationTime ?? DEFAULT_EXPIRY);
    if (durationMs == null) {
      return { error: "Invalid expiration time" };
    }
    expiresAt = nowSec + Math.floor(durationMs / 1000);
  }

  if (!Number.isFinite(expiresAt)) {
    return { error: "Invalid expiration time" };
  }
  if (expiresAt <= nowSec) {
    return { error: "Expiration time must be in the future" };
  }
  if (expiresAt - nowSec > MAX_EXPIRY_SECONDS) {
    return { error: "Expiration time cannot exceed 24 hours" };
  }
  return { expirationTime: expiresAt };
}
