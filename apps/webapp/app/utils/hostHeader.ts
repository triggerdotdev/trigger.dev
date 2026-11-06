import type { RequestHandler } from "express";
import { sanitizeHttpUrl } from "./sanitizeHttpUrl";

// A registered name or IPv4 address, or a bracketed IPv6 literal, with an optional port.
const PLAIN_HOST = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * Remix builds the request URL by concatenating the Host header in front of the path, so a Host
 * containing a character that ends a URL authority (`\`, `/`, `?`, `#`, `@`) changes the path
 * Remix routes on while every Express middleware still sees the original path.
 */
function isPlainHostHeader(host: string | undefined): boolean {
  // With no Host, Remix's URL gets the literal host "undefined", which can't move the path.
  if (host === undefined || host === "") {
    return true;
  }

  if (!PLAIN_HOST.test(host)) {
    return false;
  }

  // The allowlist admits shapes that still can't form a URL (`[:::]`), which Remix would 500 on.
  try {
    new URL(`http://${host}`);
    return true;
  } catch {
    return false;
  }
}

/** Must run before any middleware that matches on the request path. */
export function createHostHeaderGuard({
  log = (line) => console.log(line),
}: { log?: (line: string) => void } = {}): RequestHandler {
  return (req, res, next) => {
    const host = req.headers.host;
    if (!isPlainHostHeader(host)) {
      // Registered ahead of the access log, so rejections are logged here. The Host is attacker
      // controlled: JSON-quote it so it can't break the line, and cap its length.
      log(
        `${req.method} ${sanitizeHttpUrl(req.originalUrl ?? req.url ?? "")} 400 - rejected Host ${JSON.stringify(
          host?.slice(0, 200)
        )}`
      );
      res.status(400).type("text/plain").send("Bad Request");
      return;
    }

    next();
  };
}
