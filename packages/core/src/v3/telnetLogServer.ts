// Node-only. Streams log lines to connected raw-TCP ("telnet") clients for local development.
// Never import this from isomorphic/browser code — it pulls in node:net.

import net from "node:net";
import { format } from "node:util";

/**
 * Per-socket buffer cap. If a client isn't reading fast enough and its outgoing
 * buffer grows past this, we drop lines for that client rather than buffering
 * unbounded in the host process. Lossy for the lagging client only.
 */
const MAX_SOCKET_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB

// Matches ANSI escape sequences (colors, cursor moves, etc.) so the stream is plain text.
// Built via RegExp to keep literal control characters out of the source. This is the
// ansi-regex@6 pattern (post CVE-2021-3807): the alternation is de-nested so a run of
// unterminated separators (e.g. `ESC[;;;;…`) can't trigger quadratic backtracking.
const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const ANSI_PATTERN = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?" +
      ST +
      ")",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  ].join("|"),
  "g"
);

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

export type TelnetLogServerOptions = {
  /** TCP port to listen on. */
  port: number;
  /** Defaults to 127.0.0.1 — never bind a public interface for an unauthenticated stream. */
  host?: string;
  /** Short label used in startup/error messages, e.g. "webapp". */
  name: string;
  /** Optional one-line greeting written to each client on connect. */
  banner?: string;
};

/**
 * A tiny write-only TCP server that fans out log lines to every connected client.
 * Robust by design: a bind failure or a slow client never crashes the host process.
 */
export class TelnetLogServer {
  readonly name: string;
  readonly port: number;
  readonly host: string;

  #server: net.Server;
  #sockets = new Set<net.Socket>();
  #banner?: string;

  constructor(options: TelnetLogServerOptions) {
    this.name = options.name;
    this.port = options.port;
    this.host = options.host ?? "127.0.0.1";
    this.#banner = options.banner;

    this.#server = net.createServer((socket) => this.#handleConnection(socket));
    this.#server.on("error", (err) => this.#handleServerError(err as NodeJS.ErrnoException));
  }

  /** Begin listening. Returns `this`. Bind failures are swallowed (logged, not thrown). */
  start(): this {
    this.#server.listen(this.port, this.host, () => {
      process.stdout.write(`[telnet-logs] ${this.name} streaming on ${this.host}:${this.port}\n`);
    });
    // A dev-only side-channel must never keep the host process alive on its own.
    this.#server.unref();
    return this;
  }

  /** Write one line to every healthy client. Lagging clients (over the buffer cap) are skipped. */
  broadcast(line: string): void {
    if (this.#sockets.size === 0) {
      return;
    }

    const data = line.replace(/\r?\n$/, "") + "\r\n";

    for (const socket of this.#sockets) {
      if (socket.destroyed) {
        this.#sockets.delete(socket);
        continue;
      }
      if (socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
        // Lagging client — drop this line rather than buffer unbounded.
        continue;
      }
      try {
        socket.write(data);
      } catch {
        // The "error"/"close" handlers will remove it.
      }
    }
  }

  close(): void {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    this.#server.close();
  }

  #handleConnection(socket: net.Socket): void {
    socket.setNoDelay(true);
    // Like the server, a connected client must never hold the host process open.
    socket.unref();
    this.#sockets.add(socket);

    // Write-only: ignore all inbound bytes (telnet clients send IAC negotiation).
    socket.on("data", () => {});
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => {
      this.#sockets.delete(socket);
      socket.destroy();
    });

    if (this.#banner) {
      try {
        socket.write(this.#banner.replace(/\r?\n$/, "") + "\r\n");
      } catch {
        // ignore
      }
    }
  }

  #handleServerError(err: NodeJS.ErrnoException): void {
    // Never crash the host process over a logging side-channel.
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `[telnet-logs] ${this.name} disabled: port ${this.host}:${this.port} in use\n`
      );
    } else {
      process.stderr.write(`[telnet-logs] ${this.name} server error: ${err.message}\n`);
    }
  }
}

export function startTelnetLogServer(options: TelnetLogServerOptions): TelnetLogServer {
  return new TelnetLogServer(options).start();
}

const RESERVED_LOG_KEYS = new Set([
  "timestamp",
  "level",
  "$level",
  "name",
  "$name",
  "message",
  "$message",
  "skipForwarding",
]);

/**
 * Format a structured log object (from either `Logger` or `SimpleStructuredLogger`) into a
 * single plain-text line. Normalizes the two shapes (`level`/`$level`, `name`/`$name`).
 */
export function formatLogLine(log: Record<string, unknown>): string {
  const ts = log.timestamp;
  const timestamp =
    ts instanceof Date ? ts.toISOString() : typeof ts === "string" ? ts : new Date().toISOString();

  const level = String(log.level ?? log.$level ?? "log")
    .toUpperCase()
    .padEnd(5);
  const name = log.name ?? log.$name;
  const message = typeof log.message === "string" ? log.message : "";

  const extras: string[] = [];
  for (const [key, value] of Object.entries(log)) {
    if (RESERVED_LOG_KEYS.has(key) || value === undefined) {
      continue;
    }
    extras.push(`${key}=${formatValue(value)}`);
  }

  const namePart = name ? ` [${String(name)}]` : "";
  const extraPart = extras.length ? ` {${extras.join(", ")}}` : "";
  return `${timestamp} ${level}${namePart} ${message}${extraPart}`;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Given a single console line, pretty-format it if it's a JSON structured log (as emitted by
 * `Logger`/`SimpleStructuredLogger`, including bundled copies in plugins). Otherwise returns it
 * unchanged. Lets a console tap surface structured logs as readable lines while passing plain
 * `console.log` output through verbatim.
 */
export function formatConsoleLine(line: string): string {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("{")) {
    return line;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return line;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).message !== "string" ||
    ((parsed as Record<string, unknown>).level === undefined &&
      (parsed as Record<string, unknown>).$level === undefined)
  ) {
    return line;
  }
  return formatLogLine(parsed as Record<string, unknown>);
}

/**
 * Mirror `console.*` output to a telnet server. Use this (rather than the `Logger.onLog` sink)
 * when you need to capture EVERYTHING on stdout — including logs from a separate/bundled copy of
 * the logger (e.g. a plugin), which the static `onLog` hook can't see. With `pretty` (default),
 * JSON structured-log lines are reformatted via `formatConsoleLine`; other output passes through.
 * Returns a restore function.
 */
export function patchConsoleToTelnet(
  server: TelnetLogServer,
  options?: { pretty?: boolean }
): () => void {
  const pretty = options?.pretty ?? true;
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = {} as Record<(typeof methods)[number], (...args: unknown[]) => void>;

  for (const method of methods) {
    originals[method] = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]) => {
      originals[method](...args);
      try {
        const line = format(...args);
        server.broadcast(stripAnsi(pretty ? formatConsoleLine(line) : line));
      } catch {
        // never let the mirror break console
      }
    };
  }

  return () => {
    for (const method of methods) {
      console[method] = originals[method] as never;
    }
  };
}
