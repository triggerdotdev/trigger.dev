import { worker } from "@electric-sql/pglite/worker";
import { client } from "./client";

worker({
  async init(options) {
    return client(options);
  },
});
