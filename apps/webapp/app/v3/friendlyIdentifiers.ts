import { customAlphabet } from "nanoid";

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

export function generateFriendlyId(prefix: string) {
  return `${prefix}_${idGenerator()}`;
}
