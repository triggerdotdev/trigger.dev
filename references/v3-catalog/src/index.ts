import { simplestTask } from "./trigger/simple";

export async function main() {
  return await simplestTask.trigger({ payload: { url: "https://enwtxvf9j4t2.x.pipedream.net/" } });
}

main().then(console.log).catch(console.error);
