import { customAlphabet } from "nanoid";

export function getDockerHostDomain() {
  const isMacOs = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  return isMacOs || isWindows ? "host.docker.internal" : "localhost";
}

export class IdGenerator {
  private alphabet: string;
  private length: number;
  private prefix: string;

  constructor({ alphabet, length, prefix }: { alphabet: string; length: number; prefix: string }) {
    this.alphabet = alphabet;
    this.length = length;
    this.prefix = prefix;
  }

  generate(): string {
    return `${this.prefix}${customAlphabet(this.alphabet, this.length)()}`;
  }
}

export const RunnerId = new IdGenerator({
  alphabet: "123456789abcdefghijkmnopqrstuvwxyz",
  length: 20,
  prefix: "runner_",
});
