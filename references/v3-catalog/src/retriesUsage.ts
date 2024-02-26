import { taskWithRetries, taskWithFetchRetries } from "./trigger/retries";

export async function main() {
  await taskWithFetchRetries.trigger({ payload: "test" });
}

main().then(console.log).catch(console.error);
