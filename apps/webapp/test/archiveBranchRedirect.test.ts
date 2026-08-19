// The archive dialog submits the page it was opened from, so archiving from a
// paginated or filtered branches list must land back on that exact page instead
// of a bare branches path that resets the list to page 1.

import { describe, expect, it, vi } from "vitest";
import { action } from "~/routes/resources.branches.archive";

vi.mock("~/services/session.server", () => ({
  requireUserId: vi.fn().mockResolvedValue("user_1"),
}));

const archiveSucceeds = { value: true };

vi.mock("~/services/archiveBranch.server", () => ({
  ArchiveBranchService: class {
    async call() {
      return archiveSucceeds.value
        ? { success: true as const, branch: { branchName: "feat/checkout" } }
        : { success: false as const, error: "Failed to archive branch" };
    }
  },
}));

const LIST_PATH = "/orgs/o/projects/p/env/preview/branches?page=3&search=feat";

async function archive(redirectPath: string) {
  const body = new URLSearchParams({ environmentId: "env_1", redirectPath });

  return (await (action as any)({
    request: new Request("https://app.example.com/resources/branches/archive", {
      method: "POST",
      body,
    }),
    params: {},
    context: {},
  })) as Response;
}

describe("archiving a branch returns to the page it was started from", () => {
  it("preserves the query string on success", async () => {
    const response = await archive(LIST_PATH);

    expect(response.headers.get("Location")).toBe(LIST_PATH);
  });

  it("preserves the query string on failure", async () => {
    archiveSucceeds.value = false;
    const response = await archive(LIST_PATH);
    archiveSucceeds.value = true;

    expect(response.headers.get("Location")).toBe(LIST_PATH);
  });

  it("keeps the redirect same-origin", async () => {
    const response = await archive("//evil.example.com/branches");

    expect(response.headers.get("Location")).toBe("/");
  });
});
