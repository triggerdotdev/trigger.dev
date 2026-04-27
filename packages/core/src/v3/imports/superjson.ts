// Use vendored superjson bundle to avoid ESM/CJS compatibility issues
// See: https://github.com/triggerdotdev/trigger.dev/issues/2937
// @ts-ignore
import superjson from "../vendor/superjson.mjs";

superjson.registerCustom<Buffer, number[]>(
  {
    isApplicable: (v: unknown): v is Buffer => typeof Buffer === "function" && Buffer.isBuffer(v),
    serialize: (v: Buffer) => [...v],
    deserialize: (v: number[]) => Buffer.from(v),
  },
  "buffer"
);

// @ts-ignore
export default superjson;
