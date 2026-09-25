import { ZodIpcConnection } from "../../src/v3/zodIpc.js";
import { ChildToParent, ParentToChild } from "./zodIpcCatalog.js";

// Forked by zodIpc.test.ts: answers the parent's messages over the real IPC channel.
new ZodIpcConnection({
  listenSchema: ParentToChild,
  emitSchema: ChildToParent,
  process,
  handlers: {
    FLUSH: async () => {},
    PING: async ({ value }) => ({ echoed: value }),
  },
});
