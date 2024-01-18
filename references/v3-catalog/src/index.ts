import { simplestTask } from "./trigger/simple";

export async function main() {
  return await simplestTask.trigger({ payload: { url: "https://enig6u3k3jhj.x.pipedream.net/" } });
}

main().then(console.log).catch(console.error);
