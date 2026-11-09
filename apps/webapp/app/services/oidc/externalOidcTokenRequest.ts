import { z } from "zod";

const MAX_AUDIENCE_LENGTH = 2_048;

export const ExternalOidcTokenRequest = z
  .object({
    // An audience is an opaque signed value. It is never fetched or used as a URL.
    audience: z
      .string()
      .min(1)
      .max(MAX_AUDIENCE_LENGTH)
      .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), {
        message: "Audience must not contain control characters or surrounding whitespace",
      }),
    awsSessionTags: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !value.awsSessionTags || value.audience === "sts.amazonaws.com", {
    message: "awsSessionTags requires audience sts.amazonaws.com",
  });
