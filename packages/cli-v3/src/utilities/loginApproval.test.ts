import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalCallback,
  createPkcePair,
  listenForApprovalCallback,
  LoginTimedOutError,
  waitForApprovalCode,
} from "./loginApproval.js";

describe("createPkcePair", () => {
  it("derives an S256 challenge the server can check", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();

    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge).toBe(createHash("sha256").update(codeVerifier).digest("base64url"));
    expect(createPkcePair().codeVerifier).not.toBe(codeVerifier);
  });
});

describe("listenForApprovalCallback", () => {
  let callback: ApprovalCallback | undefined;

  afterEach(() => {
    callback?.close();
    callback = undefined;
  });

  it("resolves with the approval code the browser is redirected with", async () => {
    callback = await listenForApprovalCallback("Return to your terminal to continue.");

    const response = await fetch(
      `http://127.0.0.1:${callback.port}/callback?approval_code=ABCD-EFGH-JKLM`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Return to your terminal to continue.");
    expect(await callback.approvalCode).toBe("ABCD-EFGH-JKLM");
  });

  it("ignores requests that don't carry an approval code", async () => {
    callback = await listenForApprovalCallback("Return to your terminal to continue.");

    const missingCode = await fetch(`http://127.0.0.1:${callback.port}/callback`);
    const otherPath = await fetch(`http://127.0.0.1:${callback.port}/?approval_code=ABCD`);

    expect(missingCode.status).toBe(404);
    expect(otherPath.status).toBe(404);
  });

  it("times out when no browser comes back", async () => {
    callback = await listenForApprovalCallback("Return to your terminal to continue.");

    await expect(waitForApprovalCode(callback, 50, "timed out")).rejects.toThrow(
      new LoginTimedOutError("timed out")
    );
  });
});
