export function assertUnreachable(x: never): never {
  throw new Error("Didn't expect to get here");
}
