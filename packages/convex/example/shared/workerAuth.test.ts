import { expect, test } from "vitest";
import { jobWorkerToken } from "./workerAuth";

test("artifact credentials are deterministic and bound to both job and server secret", async () => {
  const first = await jobWorkerToken("a".repeat(64), "job-one");
  expect(await jobWorkerToken("a".repeat(64), "job-one")).toBe(first);
  expect(await jobWorkerToken("a".repeat(64), "job-two")).not.toBe(first);
  expect(await jobWorkerToken("b".repeat(64), "job-one")).not.toBe(first);
});

test("artifact authentication fails closed without its server secret", async () => {
  await expect(jobWorkerToken(undefined, "job-one")).rejects.toThrow("not configured");
});
