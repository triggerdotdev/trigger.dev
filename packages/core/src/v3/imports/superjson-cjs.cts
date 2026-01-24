/**
 * Vendored superjson import (CJS version)
 *
 * This module provides a bundled version of superjson that works in CJS
 * environments without relying on Node.js's experimental require(ESM) feature.
 *
 * The bundle is created from superjson@2.2.1 using esbuild.
 */

// @ts-ignore - Pre-built bundle doesn't have TS declarations
// eslint-disable-next-line @typescript-eslint/no-require-imports
const superjson = require("../vendor/superjson.cjs");

// Register Buffer serialization for Node.js environments
// @ts-ignore - Type assertions not needed for runtime behavior
superjson.registerCustom(
  {
    isApplicable: (v: unknown): v is Buffer => typeof Buffer === "function" && Buffer.isBuffer(v),
    serialize: (v: Buffer) => [...v],
    deserialize: (v: number[]) => Buffer.from(v),
  },
  "buffer"
);

// @ts-ignore
module.exports.default = superjson;
