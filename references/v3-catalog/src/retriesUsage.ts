import { taskWithRetries } from "./trigger/retries";

export async function main() {
  await taskWithRetries.trigger({ payload: "test" });
}

main().then(console.log).catch(console.error);
