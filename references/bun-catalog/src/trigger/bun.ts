import { Database } from "bun:sqlite";
import { task } from "@trigger.dev/sdk";

export const bunTask = task({
  id: "bun-task",
  run: async (payload: { query: string }) => {
    const db = new Database(":memory:");
    const query = db.query("select 'Hello world' as message;");
    console.log(query.get()); // => { message: "Hello world" }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    return {
      message: "Query executed",
      bunVersion: Bun.version,
    };
  },
});
