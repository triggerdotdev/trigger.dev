import { expect, it } from "vitest";
import { resolveBranchPresence } from "./gitHubBranchPresence";

const notFound = () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
const found = () => Promise.resolve({});

it("reports an existing branch", async () => {
  expect(await resolveBranchPresence(found, notFound)).toBe("exists");
});

it("reports a missing branch only when the repository is visible", async () => {
  expect(await resolveBranchPresence(notFound, found)).toBe("missing");
});

it("reports lost repository access instead of a missing branch", async () => {
  // GitHub answers 404 for both when the installation can no longer see the repository.
  expect(await resolveBranchPresence(notFound, notFound)).toBe("repository_inaccessible");
});

it("rethrows anything that isn't a 404", async () => {
  const unavailable = () =>
    Promise.reject(Object.assign(new Error("Unavailable"), { status: 503 }));
  await expect(resolveBranchPresence(unavailable, found)).rejects.toThrow("Unavailable");
  await expect(resolveBranchPresence(notFound, unavailable)).rejects.toThrow("Unavailable");
});
