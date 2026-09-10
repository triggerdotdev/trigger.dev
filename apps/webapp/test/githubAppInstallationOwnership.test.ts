import { describe, expect, it, vi } from "vitest";
import {
  getAuthenticatedGitHubLogin,
  verifyGitHubAppInstallationAccess,
} from "../app/services/gitHubInstallationOwnership.server";

type GitHubUserInstallationClient = Parameters<typeof verifyGitHubAppInstallationAccess>[0];

function userOctokit(request: ReturnType<typeof vi.fn>): GitHubUserInstallationClient {
  return { request } as unknown as GitHubUserInstallationClient;
}

describe("verifyGitHubAppInstallationAccess", () => {
  it("accepts an installation accessible to the authenticated GitHub user", async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        total_count: 1,
        installations: [{ id: 123 }],
      },
    });

    await expect(
      verifyGitHubAppInstallationAccess(userOctokit(request), 123)
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith("GET /user/installations", {
      page: 1,
      per_page: 100,
    });
  });

  it("checks subsequent pages", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          total_count: 101,
          installations: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
        },
      })
      .mockResolvedValueOnce({
        data: {
          total_count: 101,
          installations: [{ id: 999 }],
        },
      });

    await expect(
      verifyGitHubAppInstallationAccess(userOctokit(request), 999)
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenLastCalledWith("GET /user/installations", {
      page: 2,
      per_page: 100,
    });
  });

  it("rejects an installation the authenticated GitHub user cannot access", async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        total_count: 1,
        installations: [{ id: 123 }],
      },
    });

    await expect(verifyGitHubAppInstallationAccess(userOctokit(request), 456)).rejects.toThrow(
      "GitHub App installation is not accessible to the authenticated GitHub user"
    );
  });

  it("fails closed when GitHub cannot verify installation access", async () => {
    const request = vi.fn().mockRejectedValue(new Error("GitHub unavailable"));

    await expect(verifyGitHubAppInstallationAccess(userOctokit(request), 123)).rejects.toThrow(
      "GitHub unavailable"
    );
  });
});

describe("getAuthenticatedGitHubLogin", () => {
  it("returns the login of the authenticated GitHub user", async () => {
    const request = vi.fn().mockResolvedValue({ data: { login: "octocat" } });

    await expect(getAuthenticatedGitHubLogin(userOctokit(request))).resolves.toBe("octocat");

    expect(request).toHaveBeenCalledWith("GET /user");
  });

  it("rejects when GitHub returns no login", async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });

    await expect(getAuthenticatedGitHubLogin(userOctokit(request))).rejects.toThrow(
      "GitHub did not return a login for the authenticated user"
    );
  });
});
