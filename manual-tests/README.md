# Manual Tests

This directory contains manual test scripts for verifying features and investigating issues.

## Large Payload Handling Tests

### `test-parsePacket-decompression.js`

Unit test for the auto-decompression feature.

**Purpose**: Verify that `parsePacket()` correctly handles compressed payloads with `_compressed` and `_encoding` fields.

**How to run**:

```bash
# From repository root
pnpm run build --filter "@trigger.dev/core"
node manual-tests/test-parsePacket-decompression.js
```

**What it tests**:

- Success case: Compressed payload is correctly decompressed
- Failure cases: Invalid base64, invalid gzip, missing fields, unsupported encodings

### `test-payload-limit.js`

Comparison test showing compressed vs uncompressed payload behavior against the 3MB API limit.

**Purpose**: Demonstrate how compression allows larger payloads to bypass the 3MB middleware limit.

**How to run**:

```bash
# Requires webapp running on localhost:3030
node manual-tests/test-payload-limit.js
```

**What it tests**:

- 2MB, 10MB payloads both compressed and uncompressed
- Shows compression bypasses the 3MB limit

### `test-e2e-decompression.js`

End-to-end test with actual task execution.

**Purpose**: Test the complete flow from backend → API → worker → task with compression.

**How to run**:

```bash
# Terminal 1: Start webapp
pnpm run dev --filter webapp

# Terminal 2: Start hello-world (if needed)
cd references/hello-world
pnpm exec trigger dev

# Terminal 3: Run test
node manual-tests/test-e2e-decompression.js
```

**Prerequisites**:

- A Task must be registered and have its Id
- Webapp running on localhost:3030

## Notes

These are manual test scripts for investigation and demonstration purposes. They are not part of the automated test suite.
