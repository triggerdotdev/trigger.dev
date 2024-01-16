import { customAlphabet } from "nanoid";

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

export function generateRunId() {
  return `run_${idGenerator()}`;
}
