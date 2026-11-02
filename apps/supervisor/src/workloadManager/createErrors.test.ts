import { ApiException } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
  dockerContainerGone,
  dockerCreateRefused,
  k8sCreateRefused,
  k8sErrorMessage,
} from "./createErrors.js";

/** What client-node raises for a non-2xx answer: the body is the response's raw text. */
function apiError(code: number, message?: string) {
  const body =
    message === undefined ? undefined : JSON.stringify({ kind: "Status", code, message });
  return new ApiException(code, "Unknown API Status Code!", body, {});
}

/** What docker-modem raises for a non-2xx answer from the daemon or a proxy in front of it. */
function dockerError(statusCode: number, reason: string, detail: string) {
  return Object.assign(new Error(`(HTTP code ${statusCode}) ${reason} - ${detail} `), {
    statusCode,
    reason,
  });
}

/** What a socket error looks like from node:http or node-fetch. */
function socketError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe("k8sCreateRefused", () => {
  it.each([400, 401, 403, 404, 422])("is true for a %i", (code) => {
    expect(k8sCreateRefused(apiError(code, "refused"))).toBe(true);
  });

  it.each([408, 409, 500, 504])("is false for a %i, after which the object may exist", (code) => {
    expect(k8sCreateRefused(apiError(code, "maybe created"))).toBe(false);
  });

  it("is false for a 429, which asks every create to slow down", () => {
    expect(k8sCreateRefused(apiError(429, "Too many requests"))).toBe(false);
  });

  it("is false for a network error", () => {
    expect(k8sCreateRefused(socketError("ECONNRESET", "socket hang up"))).toBe(false);
  });
});

describe("k8sErrorMessage", () => {
  it("reads the message from the response body", () => {
    expect(k8sErrorMessage(apiError(403, "pods is forbidden: exceeded quota"))).toBe(
      "pods is forbidden: exceeded quota"
    );
  });

  it("falls back to the error's message without a body", () => {
    expect(k8sErrorMessage(apiError(401))).toContain("HTTP-Code: 401");
  });
});

describe("dockerCreateRefused", () => {
  it.each([
    ["a missing image", dockerError(404, "no such container", "No such image: task:1")],
    ["a bad request", dockerError(400, "bad parameter", "invalid reference format")],
    ["a failed start", dockerError(500, "server error", "OCI runtime create failed")],
  ])("is true for %s", (_name, error) => {
    expect(dockerCreateRefused(error)).toBe(true);
  });

  it.each([
    ["a name in use", dockerError(409, "name conflicts", "Conflict. The container name is in use")],
    ["a container that already started", dockerError(304, "container already started", "")],
    ["a lost response", socketError("ECONNRESET", "socket hang up")],
    [
      "a request the proxy did not forward",
      dockerError(503, "unexpected", "No server is available"),
    ],
    ["a proxy that lost the daemon's answer", dockerError(502, "unexpected", "Bad Gateway")],
    ["a proxy timeout", dockerError(504, "unexpected", "Gateway Time-out")],
    [
      "a daemon answer that timed out",
      dockerError(500, "server error", "context deadline exceeded"),
    ],
    [
      "a daemon whose client timed out",
      dockerError(500, "server error", "Client.Timeout exceeded while awaiting headers"),
    ],
    ["a daemon that is down", socketError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:2375")],
    ["a missing daemon socket", socketError("ENOENT", "connect ENOENT /var/run/docker.sock")],
    ["a socket this process may not open", socketError("EACCES", "connect EACCES")],
    ["a failed TLS handshake", socketError("CERT_HAS_EXPIRED", "certificate has expired")],
    ["an error without the daemon's answer", new Error("create returned 503: template_not_found")],
  ])("is false for %s", (_name, error) => {
    expect(dockerCreateRefused(error)).toBe(false);
  });
});

describe("dockerContainerGone", () => {
  it.each([
    [404, true],
    [409, true],
    [500, false],
  ])("is %s for a %i from remove", (statusCode, gone) => {
    expect(dockerContainerGone(dockerError(statusCode, "x", "y"))).toBe(gone);
  });
});
