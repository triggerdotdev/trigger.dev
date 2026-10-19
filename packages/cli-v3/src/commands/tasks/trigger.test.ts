import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeDeadline, readPayload } from "./trigger.js";

describe("readPayload", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function payloadFile(contents: string) {
    const dir = await mkdtemp(join(tmpdir(), "tasks-trigger-"));
    dirs.push(dir);
    const path = join(dir, "payload.json");
    await writeFile(path, contents);
    return path;
  }

  it("returns undefined when no payload is given", async () => {
    expect(await readPayload({})).toBeUndefined();
  });

  it("parses --payload as JSON", async () => {
    expect(await readPayload({ payload: '{"name":"Ada"}' })).toEqual({ name: "Ada" });
    expect(await readPayload({ payload: '"just a string"' })).toBe("just a string");
  });

  it("reads and parses --payload-file", async () => {
    const path = await payloadFile('{"items":[1,2,3]}');

    expect(await readPayload({ payloadFile: path })).toEqual({ items: [1, 2, 3] });
  });

  it("says which flag has invalid JSON", async () => {
    await expect(readPayload({ payload: "{name:1}" })).rejects.toThrow(
      "--payload isn't valid JSON"
    );

    const path = await payloadFile("not json");
    await expect(readPayload({ payloadFile: path })).rejects.toThrow(`${path} isn't valid JSON`);
  });

  it("rejects --payload and --payload-file together", async () => {
    await expect(readPayload({ payload: "{}", payloadFile: "payload.json" })).rejects.toThrow(
      "Pass either --payload or --payload-file, not both."
    );
  });
});

describe("beforeDeadline", () => {
  it("resolves to the value when it settles before the deadline", async () => {
    expect(await beforeDeadline(Promise.resolve("done"), Date.now() + 1_000)).toBe("done");
  });

  it("waits without a deadline", async () => {
    expect(await beforeDeadline(Promise.resolve("done"), undefined)).toBe("done");
  });

  it("resolves to undefined when a request is still in flight at the deadline", async () => {
    const neverSettles = new Promise<string>(() => {});
    const started = Date.now();

    expect(await beforeDeadline(neverSettles, started + 50)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("resolves to undefined straight away when the deadline has passed", async () => {
    const neverSettles = new Promise<string>(() => {});

    expect(await beforeDeadline(neverSettles, Date.now() - 1)).toBeUndefined();
  });

  it("passes on errors from before the deadline", async () => {
    await expect(
      beforeDeadline(Promise.reject(new Error("boom")), Date.now() + 1_000)
    ).rejects.toThrow("boom");
  });
});
