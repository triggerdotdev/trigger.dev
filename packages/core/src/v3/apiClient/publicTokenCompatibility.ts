import { z } from "zod/v4";

// Existing root keys have 20 characters of entropy; newer root keys have 24.
const ROOT_API_KEY_PATTERN = /^tr_(dev|stg|prod|preview)_[0-9a-zA-Z]{20}(?:[0-9a-zA-Z]{4})?$/;

const LegacyEmptyScopesError = z.object({
  error: z.literal("Invalid request body"),
  issues: z.tuple([
    z.object({
      code: z.literal("too_small"),
      minimum: z.literal(1),
      inclusive: z.literal(true),
      path: z.tuple([z.literal("scopes")]),
    }),
  ]),
});

export function canFallbackToLocalPublicToken(
  accessToken: string,
  scopes: string[],
  status: number | undefined,
  responseBody?: unknown
): boolean {
  if (!ROOT_API_KEY_PATTERN.test(accessToken)) return false;
  if (status === 404) return true;

  // Before v4.8.4, the mint endpoint required at least one scope.
  return (
    status === 400 && scopes.length === 0 && LegacyEmptyScopesError.safeParse(responseBody).success
  );
}
