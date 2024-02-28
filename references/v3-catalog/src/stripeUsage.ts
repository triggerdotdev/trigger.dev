import { stripeTask } from "./trigger/stripe";

export async function main() {
  await stripeTask.trigger({
    payload: { prompt: "Write a short poem about TypeScript and Background Jobs" },
  });
}

main().then(console.log).catch(console.error);
