const { gzip } = require("zlib");
const { promisify } = require("util");

const gzipAsync = promisify(gzip);

const TASK_ID = "your-task-id";
const API_URL = `http://localhost:3030/api/v1/tasks/${TASK_ID}/trigger`;
const API_KEY = "tr_dev_..."; // your dev api here

async function testE2E() {
  console.log("End-to-end test: Compression with real task execution\n");

  const largeData = {
    records: Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `Record ${i}`,
      data: "x".repeat(100),
    })),
  };

  const jsonString = JSON.stringify(largeData);
  const compressed = await gzipAsync(jsonString);
  const compressedBase64 = compressed.toString("base64");

  console.log(`Original size: ${jsonString.length} bytes`);
  console.log(`Compressed size: ${compressedBase64.length} bytes`);
  console.log(
    `Savings: ${((1 - compressedBase64.length / jsonString.length) * 100).toFixed(1)}%\n`
  );

  console.log("Triggering task...");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        payload: {
          _compressed: compressedBase64,
          _encoding: "gzip-base64",
          metadata: { test: "e2e test", timestamp: Date.now() },
        },
      }),
    });

    console.log(`Response: ${response.status}`);
    const result = await response.json();
    console.log(`Run ID: ${result.id}\n`);

    if (response.ok) {
      console.log("SUCCESS - Task triggered");
      console.log(`\nCheck the task run in the webapp:`);
      console.log(`http://localhost:3030/runs/${result.id}`);
      console.log(`\nTask should log:`);
      console.log(`  - recordCount: 1000`);
      console.log(`  - hasCompressedField: false`);
      console.log(`  - hasEncodingField: false`);
      console.log(`  - receivedCleanData: true`);
    } else {
      console.log("FAILED:", result);
    }
  } catch (error) {
    console.log("ERROR:", error.message);
  }
}

testE2E();
