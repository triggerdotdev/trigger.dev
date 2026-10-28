import { z } from "zod/v4";

export const ParentToChild = {
  FLUSH: {
    message: z.object({ timeoutInMs: z.number() }),
    callback: z.void(),
  },
  PING: {
    message: z.object({ value: z.string() }),
    callback: z.object({ echoed: z.string() }),
  },
  // The child never answers this one.
  STALL: {
    message: z.object({ secret: z.string() }),
    callback: z.void(),
  },
};

export const ChildToParent = {};
