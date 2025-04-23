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
