import { createHash } from "node:crypto";

/**
 * Returns the binary hash of a binary value. Hash function and output length are configurable.
 */
function hash(data: Uint8Array, outputLength = 32, type = "sha256"): Uint8Array {
  const hasher = createHash(type);
  hasher.update(data);
  let hash = new Uint8Array(hasher.digest());
  hash = hash.subarray(0, outputLength);
  return hash;
}

export function jumpHash(key: string, buckets: number): number {
  return jumpConsistentHash(hash(Buffer.from(key)), buckets);
}

/**
 * Based on Node.js's Buffer implementation: https://github.com/nodejs/node/blob/ed8fc7e11d688cbcdf33d0d149830064758bdcd2/lib/internal/buffer.js#L98
 * @param bytes
 */
function bytesToBigInt(bytes: Uint8Array): bigint {
  const hi = bytes[0]! * 2 ** 24 + bytes[1]! * 2 ** 16 + bytes[2]! * 2 ** 8 + bytes[3]!;
  const lo = bytes[4]! * 2 ** 24 + bytes[5]! * 2 ** 16 + bytes[6]! * 2 ** 8 + bytes[7]!;

  // tslint:disable-next-line:no-bitwise
  return (BigInt(hi) << 32n) + BigInt(lo);
}

/**
 * @param {Uint8Array} key 8 bytes (represents uint64 number)
 * @param {number} numBuckets Up to 32-bit number
 *
 * @return {number} Bucket from `[0, numBuckets)` range
 */
function jumpConsistentHash(key: Uint8Array, numBuckets: number): number {
  let keyBigInt = bytesToBigInt(key);
  let b = -1n;
  let j = 0n;
  while (j < numBuckets) {
    b = j;
    // We fit the number after multiplication within 64-bit range, just like in C++ implementation from paper
    keyBigInt = ((keyBigInt * 2862933555777941757n) % 2n ** 64n) + 1n;
    // Here we need to divide numbers as double (like in C++ implementation from paper), hence converting back to numbers for that
    // tslint:disable-next-line:no-bitwise
    j = BigInt(Math.floor(((Number(b) + 1) * Number(1n << 31n)) / Number((keyBigInt >> 33n) + 1n)));
  }
  return Number(b);
}
