import { customAlphabet } from "nanoid";

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

export function generateFriendlyId(prefix: string, size?: number) {
  return `${prefix}_${idGenerator(size)}`;
}
