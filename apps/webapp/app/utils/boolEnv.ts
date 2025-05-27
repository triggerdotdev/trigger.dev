import { z } from "zod";

export const BoolEnv = z.preprocess((val) => {
  if (typeof val !== "string") {
    return val;
  }

  return ["true", "1"].includes(val.toLowerCase().trim());
}, z.boolean());
