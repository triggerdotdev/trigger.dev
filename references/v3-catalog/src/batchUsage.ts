import { batchParentTask } from "./trigger/batch";

export async function main() {
  await batchParentTask.trigger({
    payload: "This is a batch parent task",
  });
}

main().then(console.log).catch(console.error);
