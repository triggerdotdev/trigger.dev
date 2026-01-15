// @ts-ignore
import superjson from "superjson";

superjson.registerCustom<Buffer, number[]>(
  {
    isApplicable: (v): v is Buffer => typeof Buffer === "function" && Buffer.isBuffer(v),
    serialize: (v) => [...v],
    deserialize: (v) => Buffer.from(v),
  },
  "buffer"
);

// @ts-ignore
export default superjson;
