import { z } from "zod";

export const CoercedDate = z.preprocess((arg) => {
  if (arg === undefined || arg === null) {
    return;
  }

  if (typeof arg === "number") {
    return new Date(arg);
  }

  if (typeof arg === "string") {
    const num = Number(arg);
    if (!isNaN(num)) {
      return new Date(num);
    }

    return new Date(arg);
  }

  return arg;
}, z.date().optional());

/**
 * Zod's `z.coerce.boolean()` doesn't work as _expected_ with "true" and "false" strings.
 * as it coerces both to `true`. This type is a workaround for that.
 */
export const CoercedBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
]);
