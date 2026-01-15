// @ts-ignore
const { default: superjson } = require("superjson");

// @ts-ignore
superjson.registerCustom<Buffer, number[]>(
  {
    isApplicable: (v: unknown): v is Buffer => typeof Buffer === "function" && Buffer.isBuffer(v),
    serialize: (v: Buffer) => [...v],
    deserialize: (v: number[]) => Buffer.from(v),
  },
  "buffer"
);

// @ts-ignore
module.exports.default = superjson;
