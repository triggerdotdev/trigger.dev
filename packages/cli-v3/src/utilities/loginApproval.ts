import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A PKCE (S256) pair: the server keeps the challenge, only this process ever holds the verifier. */
export function createPkcePair() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export type ApprovalCallback = {
  port: number;
  approvalCode: Promise<string>;
  close: () => void;
};

/**
 * Listens on a random loopback port for the browser that approves the login. The dashboard
 * redirects only that browser to `http://127.0.0.1:<port>/callback?approval_code=...`, so the
 * approval code reaches this machine and never the party that started the login elsewhere.
 */
export async function listenForApprovalCallback(returnMessage: string): Promise<ApprovalCallback> {
  let resolveApprovalCode!: (approvalCode: string) => void;
  const approvalCode = new Promise<string>((resolve) => {
    resolveApprovalCode = resolve;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const code = url.pathname === "/callback" ? url.searchParams.get("approval_code") : null;

    if (request.method !== "GET" || !code) {
      response.writeHead(404, { Connection: "close" }).end();
      return;
    }

    response
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
      .end(approvalPage(returnMessage));
    resolveApprovalCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    approvalCode,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

export class LoginTimedOutError extends Error {}

export async function waitForApprovalCode(
  callback: ApprovalCallback,
  timeoutMs: number,
  timeoutMessage: string
) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LoginTimedOutError(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([callback.approvalCode, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function approvalPage(returnMessage: string) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Trigger.dev login approved</title></head>
<body style="font-family: system-ui, sans-serif; background: #121317; color: #d7d9dd; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
<div style="text-align: center;">
<h1 style="font-size: 1.5rem;">Trigger.dev login approved</h1>
<p>${returnMessage} You can close this tab.</p>
</div>
</body>
</html>`;
}
