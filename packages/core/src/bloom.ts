import { Buffer } from "node:buffer";

export class BloomFilter {
  private size: number;
  private bitArray: Uint8Array;

  constructor(size: number) {
    this.size = size;
    this.bitArray = new Uint8Array(Math.ceil(size / 8));
  }

  add(item: string): void {
    const index = murmurHash3(item) % this.size;
    // @ts-expect-error
    this.bitArray[Math.floor(index / 8)] |= 1 << index % 8;
  }

  test(item: string): boolean {
    const index = murmurHash3(item) % this.size;
    // @ts-expect-error
    return (this.bitArray[Math.floor(index / 8)] & (1 << index % 8)) !== 0;
  }

  // Serialize to a Base64 string
  serialize(): string {
    return Buffer.from(this.bitArray).toString("base64");
  }

  // Deserialize from a Base64 string
  static deserialize(str: string, size: number): BloomFilter {
    const filter = new BloomFilter(size);
    filter.bitArray = Uint8Array.from(Buffer.from(str, "base64"));
    return filter;
  }

  static NOOP_TASK_SET_SIZE = 32_768;
}

function murmurHash3(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0xcc9e2d51);
    h1 = (h1 << 15) | (h1 >>> 17);
    h1 = Math.imul(h1, 0x1b873593);

    h2 = Math.imul(h2 ^ ch, 0x85ebca6b);
    h2 = (h2 << 13) | (h2 >>> 19);
    h2 = Math.imul(h2, 0xc2b2ae35);
  }

  h1 ^= str.length;
  h2 ^= str.length;

  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
  h1 = Math.imul(h1 ^ (h1 >>> 13), 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  h2 = Math.imul(h2 ^ (h2 >>> 16), 0x85ebca6b);
  h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
  h2 ^= h2 >>> 16;

  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
