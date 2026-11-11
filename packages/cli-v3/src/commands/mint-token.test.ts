import { describe, expect, it } from "vitest";
import { notLoggedInMessage } from "./mint-token.js";

describe("mint-token login errors", () => {
  it("shows the server's message when the CLI login expired", () => {
    const error =
      "Your CLI login expired because it wasn't used for a while. Run `npx trigger.dev@latest login` to log in again.";

    expect(
      notLoggedInMessage({ ok: false, error, errorCode: "cli_login_expired" }, "default")
    ).toBe(error);
  });

  it("asks for a login when there is no stored login", () => {
    expect(notLoggedInMessage({ ok: false, error: "You must login first" }, "work")).toBe(
      "You must login first. Use `trigger.dev login --profile work` to login."
    );
  });
});
