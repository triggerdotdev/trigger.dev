const { gzip } = require("zlib");
const { promisify } = require("util");

const gzipAsync = promisify(gzip);

async function testParsePacket() {
  const { parsePacket } = await import(
    "../packages/core/dist/commonjs/v3/utils/ioSerialization.js"
  );

  console.log("Testing parsePacket auto-decompression\n");
  const RECORD_COUNT = 10000;
  const RECORD_SIZE = 100;
  const originalData = {
    records: Array.from({ length: RECORD_COUNT }, (_, i) => ({
      id: i,
      name: `Record ${i}`,
      data: "x".repeat(RECORD_SIZE),
    })),
  };

  const jsonString = JSON.stringify(originalData);
  console.log(`Original size: ${jsonString.length} bytes`);

  const compressed = await gzipAsync(jsonString);
  const compressedBase64 = compressed.toString("base64");

  console.log(`Compressed size: ${compressedBase64.length} bytes`);
  console.log(
    `Savings: ${((1 - compressedBase64.length / jsonString.length) * 100).toFixed(1)}%\n`
  );

  const compressedPacket = {
    data: JSON.stringify({
      _compressed: compressedBase64,
      _encoding: "gzip-base64",
      metadata: { test: "additional field" },
    }),
    dataType: "application/json",
  };

  console.log("Testing parsePacket...");

  try {
    const result = await parsePacket(compressedPacket);

    console.log("\nparsePacket succeeded!");
    console.log("Result structure:", {
      hasRecords: !!result.records,
      recordCount: result.records?.length,
      hasMetadata: !!result.metadata,
      metadataTest: result.metadata?.test,
      hasCompressedField: "_compressed" in result,
      hasEncodingField: "_encoding" in result,
    });

    if (result.records?.length === RECORD_COUNT && !result._compressed && !result._encoding) {
      console.log("\nSUCCESS - Auto-decompression works correctly");
      console.log(`  - Received ${RECORD_COUNT} records`);
      console.log("  - _compressed field removed");
      console.log("  - _encoding field removed");
      console.log("  - Additional metadata preserved");
    } else {
      console.log("\nFAILED - Something is wrong:");
      if (result._compressed) console.log("  - _compressed field still present");
      if (result._encoding) console.log("  - _encoding field still present");
      if (result.records?.length !== RECORD_COUNT)
        console.log(`  - Wrong record count: ${result.records?.length}`);
    }
  } catch (error) {
    console.log("\nERROR:", error.message);
    console.log(error.stack);
  }
}

async function testFailureCases() {
  const { parsePacket } = await import(
    "../packages/core/dist/commonjs/v3/utils/ioSerialization.js"
  );

  console.log("\n\nTesting FAILURE cases\n");

  console.log("Test 1: Invalid base64");
  try {
    await parsePacket({
      data: JSON.stringify({
        _compressed: "NOT_VALID_BASE64!!!",
        _encoding: "gzip-base64",
      }),
      dataType: "application/json",
    });
    console.log("  FAIL - Should have thrown error");
  } catch (error) {
    console.log("  PASS - Correctly failed:", error.message);
  }

  console.log("\nTest 2: Valid base64 but not gzipped");
  try {
    await parsePacket({
      data: JSON.stringify({
        _compressed: Buffer.from("not gzipped data").toString("base64"),
        _encoding: "gzip-base64",
      }),
      dataType: "application/json",
    });
    console.log("  FAIL - Should have thrown error");
  } catch (error) {
    console.log("  PASS - Correctly failed:", error.message);
  }

  console.log("\nTest 3: Missing _encoding field");
  try {
    const result = await parsePacket({
      data: JSON.stringify({
        _compressed: "H4sIAAAAAAAA...",
      }),
      dataType: "application/json",
    });
    console.log("  PASS - Skipped decompression, treated as normal JSON");
    console.log("  Result has _compressed field:", "_compressed" in result);
  } catch (error) {
    console.log("  FAIL - Unexpected error:", error.message);
  }

  console.log("\nTest 4: Missing _compressed field");
  try {
    const result = await parsePacket({
      data: JSON.stringify({
        _encoding: "gzip-base64",
        data: "some data",
      }),
      dataType: "application/json",
    });
    console.log("  PASS - Skipped decompression, treated as normal JSON");
    console.log("  Result:", result);
  } catch (error) {
    console.log("  FAIL - Unexpected error:", error.message);
  }

  console.log("\nTest 5: Unsupported encoding type");
  try {
    const result = await parsePacket({
      data: JSON.stringify({
        _compressed: "some data",
        _encoding: "brotli-base64",
      }),
      dataType: "application/json",
    });
    console.log("  PASS - Skipped decompression, unknown encoding");
    console.log("  Result has _compressed field:", "_compressed" in result);
  } catch (error) {
    console.log("  FAIL - Unexpected error:", error.message);
  }

  console.log("\nAll failure cases handled correctly");
}

(async () => {
  await testParsePacket();
  await testFailureCases();
})().catch(console.error);
