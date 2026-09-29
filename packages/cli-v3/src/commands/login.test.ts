import { describe, expect, it } from "vitest";
import { CLOUD_API_URL } from "../consts.js";
import {
  addEmailToAuthorizationUrl,
  isPendingAuthorizationValid,
  resolveLoginOptions,
} from "./login.js";

describe("resolveLoginOptions", () => {
  it("uses the cloud API when the caller passes an undefined override", () => {
    expect(resolveLoginOptions({ defaultApiUrl: undefined }).defaultApiUrl).toBe(CLOUD_API_URL);
  });

  it("preserves an explicit API URL", () => {
    expect(
      resolveLoginOptions({ defaultApiUrl: "https://trigger.example.com" }).defaultApiUrl
    ).toBe("https://trigger.example.com");
  });
});

describe("resumable login", () => {
  const pendingAuthorization = {
    authorizationCode: "code",
    url: "https://cloud.example.com/account/authorization-code/code",
    apiUrl: "https://cloud.example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("prefills the email without changing the authorization path", () => {
    expect(addEmailToAuthorizationUrl(pendingAuthorization.url, "user@example.com")).toBe(
      "https://cloud.example.com/account/authorization-code/code?email=user%40example.com"
    );
  });

  it("resumes an unexpired authorization for the same API", () => {
    expect(
      isPendingAuthorizationValid(
        pendingAuthorization,
        pendingAuthorization.apiUrl,
        Date.parse("2026-01-01T00:09:59.000Z")
      )
    ).toBe(true);
  });

  it("rejects expired authorizations and authorizations from another API", () => {
    expect(
      isPendingAuthorizationValid(
        pendingAuthorization,
        pendingAuthorization.apiUrl,
        Date.parse("2026-01-01T00:10:00.000Z")
      )
    ).toBe(false);
    expect(
      isPendingAuthorizationValid(
        pendingAuthorization,
        "https://other.example.com",
        Date.parse("2026-01-01T00:01:00.000Z")
      )
    ).toBe(false);
  });
});
