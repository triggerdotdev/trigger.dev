import { openaiTask } from "./trigger/openai";

export async function main() {
  await openaiTask.trigger({
    payload: { prompt: "Write a short poem about TypeScript and Background Jobs" },
  });
}

main().then(console.log).catch(console.error);
