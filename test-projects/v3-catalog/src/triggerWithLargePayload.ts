import { tasks, runs } from "@trigger.dev/sdk/v3";
import { anyPayloadTask } from "./trigger/simple.js";

async function main() {
  const payload = createLargePayload(100000);

  const anyHandle = await tasks.trigger<typeof anyPayloadTask>("any-payload-task", payload);

  const anyRun = await runs.poll(anyHandle);

  if (anyRun.outputPresignedUrl) {
    const response = await fetch(anyRun.outputPresignedUrl);

    console.log("## Output");
    console.log(await response.text());
  }

  if (anyRun.payloadPresignedUrl) {
    const response = await fetch(anyRun.payloadPresignedUrl);

    console.log("## Payload");
    console.log(await response.text());
  }
}

main().catch(console.error);

// Creates a large object payload, with many keys and values
function createLargePayload(size: number) {
  const payload: Record<string, any> = {};

  for (let i = 0; i < size; i++) {
    payload[`key-${i}`] = `value-${i}`;
  }

  return payload;
}
