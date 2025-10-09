const { gzip } = require("zlib");
const { promisify } = require("util");

const gzipAsync = promisify(gzip);

const TASK_ID = "example"; // this is supposed to be a real one but there is no issue since we are mostly testing middleware and req validation
const API_URL = `http://localhost:3030/api/v1/tasks/${TASK_ID}/trigger`;
const API_KEY = "tr_dev_..."; // your dev api here

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPayload(sizeInMB) {
  const sizeInBytes = sizeInMB * 1024 * 1024;
  const largeString = "x".repeat(sizeInBytes);
  return { data: largeString };
}

async function testUncompressed(sizeInMB) {
  const payload = createPayload(sizeInMB);
  const payloadString = JSON.stringify({ payload });

  console.log(`\nTesting ${sizeInMB}MB UNCOMPRESSED payload`);
  console.log(`  Size: ${payloadString.length} bytes`);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: payloadString,
    });

    console.log(`  Status: ${response.status}`);
    const result = await response.json();
    console.log(`  Response:`, result);
  } catch (error) {
    console.log(`  Error:`, error.message);
  }
}

async function testCompressed(sizeInMB) {
  const payload = createPayload(sizeInMB);
  const jsonString = JSON.stringify(payload);

  const compressed = await gzipAsync(jsonString);
  const compressedBase64 = compressed.toString("base64");

  const compressedPayload = {
    _compressed: compressedBase64,
    _encoding: "gzip-base64",
  };

  const payloadString = JSON.stringify({ payload: compressedPayload });

  console.log(`\nTesting ${sizeInMB}MB COMPRESSED payload`);
  console.log(`  Original size: ${jsonString.length} bytes`);
  console.log(`  Compressed size: ${compressedBase64.length} bytes`);
  console.log(
    `  Savings: ${((1 - compressedBase64.length / jsonString.length) * 100).toFixed(1)}%`
  );
  console.log(`  Final request size: ${payloadString.length} bytes`);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: payloadString,
    });

    console.log(`  Status: ${response.status}`);
    const result = await response.json();
    console.log(`  Response:`, result);
  } catch (error) {
    console.log(`  Error:`, error.message);
  }
}

(async () => {
  console.log("=".repeat(60));
  console.log("Payload Limit Test: Compressed vs Uncompressed");
  console.log("=".repeat(60));

  console.log("\n--- 2MB Payload (under limit) ---");
  await testUncompressed(2);
  await testCompressed(2);

  console.log("\n--- 10MB Payload (way over limit) ---");
  await testCompressed(10);
  await testUncompressed(10);

  console.log("\n" + "=".repeat(60));
  console.log("Summary:");
  console.log("- Uncompressed: Fails at 3MB+ (413 error)");
  console.log("- Compressed: Works if compressed size < 3MB");
  console.log("  (10MB of 'x' chars compresses a lot!)");
  console.log("=".repeat(60));
})();
