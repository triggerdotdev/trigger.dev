/**
 * Vendored superjson import
 *
 * This module provides a bundled version of superjson that works in both ESM and CJS
 * environments without relying on Node.js's experimental require(ESM) feature.
 *
 * The bundle is created from superjson@2.2.1 using esbuild.
 */

// @ts-ignore - Pre-built bundle doesn't have TS declarations
import superjson from "../vendor/superjson.js";

// Register Buffer serialization for Node.js environments
superjson.registerCustom<Buffer, number[]>(
  {
    isApplicable: (v: unknown): v is Buffer => typeof Buffer === "function" && Buffer.isBuffer(v),
    serialize: (v: Buffer) => [...v],
    deserialize: (v: number[]) => Buffer.from(v),
  },
  "buffer"
);

export default superjson;
