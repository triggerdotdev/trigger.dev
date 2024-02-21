import { longRunning } from "./trigger/longRunning";

export async function main() {
  await longRunning.trigger({
    payload: { message: `This is a message from longRunningUsage.ts` },
  });
}

main().then(console.log).catch(console.error);
