import { parentTask } from "./trigger/simple";

export async function main() {
  const handle = await parentTask.trigger({
    payload: { message: "This is a message from the trigger-dev CLI" },
  });

  return handle;
}

main().then(console.log).catch(console.error);
