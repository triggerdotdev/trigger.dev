import { describe, expect, it } from "vitest";
import { encodePayload, findTaskTests, MAX_PAYLOAD_BYTES, taskTestPath } from "./task-test";

const helloWorld = `import { task } from "@trigger.dev/sdk";

export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { message: string }) => {
    console.log(payload.message);
  },
});`;

describe("findTaskTests", () => {
  it("matches a task and its literal trigger in one block", () => {
    const code = `${helloWorld}\n\nawait helloWorld.trigger({ message: "Hello", n: -1, ok: true, tags: ["a"] });`;
    expect(findTaskTests([code]).get(0)).toEqual({
      taskId: "hello-world",
      payload: { message: "Hello", n: -1, ok: true, tags: ["a"] },
    });
  });

  it("matches tasks.trigger by id with type arguments, and the AndWait form", () => {
    const code = `${helloWorld}\nawait tasks.triggerAndWait<typeof helloWorld>("hello-world", { message: \`hi\` } as const);`;
    expect(findTaskTests([code]).get(0)?.payload).toEqual({ message: "hi" });
  });

  // Catches: the "define it, then trigger it from your backend" pair on tasks/overview getting no button.
  it("puts the button on the defining block when another block in the sample triggers it", () => {
    const backend = `import { helloWorld } from "./trigger/hello-world";\nconst handle = await helloWorld.trigger({ message: "Hello world!" });`;
    const found = findTaskTests([helloWorld, backend]);
    expect([...found.keys()]).toEqual([0]);
    expect(found.get(0)?.payload).toEqual({ message: "Hello world!" });
  });

  it("skips payloads that need evaluating", () => {
    for (const payload of ["payload", "{ ...rest }", "{ at: new Date() }", "{ id }", "{ [k]: 1 }"])
      expect(findTaskTests([`${helloWorld}\nawait helloWorld.trigger(${payload});`]).size).toBe(0);
  });

  // Catches: prefilling the deliberately invalid payload from tasks/schemaTask.
  it("skips calls the sample says fail", () => {
    const code = `${helloWorld}\nawait helloWorld.trigger({ message: 1 }); // this will throw an error`;
    expect(findTaskTests([code]).size).toBe(0);
  });

  it("skips a variable that names different tasks in different blocks", () => {
    const a = `const myTask = task({ id: "a", run: async () => {} });`;
    const b = `const myTask = task({ id: "b", run: async () => {} });`;
    expect(findTaskTests([a, b, `await myTask.trigger({ x: 1 });`]).size).toBe(0);
  });

  it("skips payloads over the dashboard's limit", () => {
    const big = JSON.stringify("x".repeat(MAX_PAYLOAD_BYTES));
    expect(findTaskTests([`${helloWorld}\nawait helloWorld.trigger({ m: ${big} });`]).size).toBe(0);
  });

  it("ignores samples that don't parse", () => {
    expect(findTaskTests([`${helloWorld}\nawait helloWorld.trigger({ ... });`]).size).toBe(0);
  });
});

describe("taskTestPath", () => {
  // Catches: a task only registered in dev opening as not found in the last-used environment.
  it("opens the dev environment and encodes the payload as base64url JSON", () => {
    const payload = { message: "héllo ✓", n: 1 };
    const path = taskTestPath({ taskId: "hello world", payload });
    expect(path).toBe(`/_/test/tasks/hello%20world?env=dev&payload=${encodePayload(payload)}`);
    const param = new URL(path, "https://x").searchParams.get("payload")!;
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(param, "base64url").toString("utf8"))).toEqual(payload);
  });
});
