import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ZodIpcConnection } from "../src/v3/zodIpc.js";
import { ChildToParent, ParentToChild } from "./fixtures/zodIpcCatalog.js";

const childPath = fileURLToPath(new URL("./fixtures/zodIpcChild.ts", import.meta.url));

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

// Node's default IPC serialization is JSON, so an ack with `message: undefined`
// arrives without the `message` key, exactly as it does between a worker and its task run process.
function forkChild() {
  child = fork(childPath, { execArgv: ["--import", "tsx"], stdio: "inherit" });

  return new ZodIpcConnection({
    listenSchema: ChildToParent,
    emitSchema: ParentToChild,
    process: child,
  });
}

describe("ZodIpcConnection", () => {
  it("resolves sendWithAck for a void callback", async () => {
    const connection = forkChild();

    await expect(connection.sendWithAck("FLUSH", { timeoutInMs: 1000 }, 2000)).resolves.toBe(
      undefined
    );
  });

  it("resolves sendWithAck with the callback payload", async () => {
    const connection = forkChild();

    await expect(connection.sendWithAck("PING", { value: "hello" }, 2000)).resolves.toEqual({
      echoed: "hello",
    });
  });
});
