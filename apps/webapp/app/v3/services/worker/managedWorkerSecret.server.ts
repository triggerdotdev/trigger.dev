import { timingSafeEqual } from "node:crypto";

export function matchesAnyManagedWorkerSecret(
  presented: string,
  accepted: ReadonlyArray<string | undefined>
): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(presented);

  let matched = false;

  for (const candidate of accepted) {
    if (!candidate) {
      continue;
    }

    const b = encoder.encode(candidate);

    if (a.byteLength === b.byteLength && timingSafeEqual(a, b)) {
      matched = true;
    }
  }

  return matched;
}
