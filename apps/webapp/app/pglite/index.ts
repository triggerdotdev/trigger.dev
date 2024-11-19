import { PGliteWorker } from "@electric-sql/pglite/worker";

export async function pglite() {
  return await PGliteWorker.create(
    new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    }),
    {}
  );
}
