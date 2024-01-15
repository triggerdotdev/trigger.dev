import { simplestTask } from "./trigger/simple";

export async function main() {
  await simplestTask.trigger({ payload: { url: "https://enwtxvf9j4t2.x.pipedream.net/" } });
}
