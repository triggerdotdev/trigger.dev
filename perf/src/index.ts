import { triggerClient } from "./trigger";

async function sendEvent() {
  try {
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
  } catch (err) {
    console.error(err);
  }
}

async function main() {
  console.log("Preparing perf tests...");

  // wait for 10 seconds
  await new Promise((resolve) => setTimeout(resolve, 10000));

  console.log("Starting perf tests in 1 second...");

  // wait for 1 seconds
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Send 1 event per second for 30 seconds (1 event == 10 runs)
  for (let i = 0; i < 30; i++) {
    console.log("Sending 1 event...");

    sendEvent();

    await new Promise((resolve) => setTimeout(resolve, 950));
  }

  console.log("Sending 30 events...");
  for (let i = 0; i < 30; i++) {
    await sendEvent();
  }
}

async function mainLong() {
  console.log("Preparing long perf tests...");

  // wait for 10 seconds
  await new Promise((resolve) => setTimeout(resolve, 10000));

  console.log("Starting long perf tests in 1 second...");

  // wait for 1 seconds
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Send 1 events every 5 seconds for 30 minutes
  for (let i = 0; i < 360; i++) {
    console.log("Sending 1 events...");

    await sendEvent();

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

mainLong().catch((err) => {
  console.error(err);
  process.exit(1);
});
