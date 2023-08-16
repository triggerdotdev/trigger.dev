import { triggerClient } from "./trigger";

async function sendEvent() {
  return await triggerClient.sendEvent({
    name: "perf.test",
    payload: {
      string: "Hello, World!",
      number: 42,
      boolean: true,
      nullValue: null,
      array: [1, 2, 3],
      object: {
        nestedString: "Nested value",
        nestedNumber: 3.14,
        nestedArray: ["apple", "banana", "cherry"],
        nestedObject: {
          nestedBoolean: false,
          nestedNull: null,
        },
      },
    },
  });
}

async function main() {
  console.log("Preparing perf tests...");

  // wait for 10 seconds
  await new Promise((resolve) => setTimeout(resolve, 10000));

  console.log("Starting perf tests in 1 second...");

  // wait for 1 seconds
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Send 10 events per second for 30 seconds
  for (let i = 0; i < 30; i++) {
    console.log("Sending 10 events...");

    await Promise.all([
      sendEvent(),
      sendEvent(),
      sendEvent(),
      sendEvent(),
      sendEvent(),
      sendEvent(),
      sendEvent(),
      sendEvent(),
      sendEvent(),
      sendEvent(),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 950));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
