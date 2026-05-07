// Use vendored superjson bundle to avoid ESM/CJS compatibility issues
// See: https://github.com/triggerdotdev/trigger.dev/issues/2937
// @ts-ignore
const superjson = require("../vendor/superjson.cjs");

// @ts-ignore
superjson.default.registerCustom<Buffer, number[]>(
  {
    isApplicable: (v: unknown): v is Buffer => typeof Buffer === "function" && Buffer.isBuffer(v),
    serialize: (v: Buffer) => [...v],
    deserialize: (v: number[]) => Buffer.from(v),
  },
  "buffer"
);

// @ts-ignore
module.exports.default = superjson.default;
