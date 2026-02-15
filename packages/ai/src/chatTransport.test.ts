import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryTriggerChatRunStore,
  createTriggerChatTransport,
  normalizeTriggerChatHeaders,
  TriggerChatTransport,
} from "./chatTransport.js";
import type { TriggerChatStream } from "./types.js";
import type { UIMessage, UIMessageChunk } from "ai";
import type {
  TriggerChatTransportError,
  TriggerChatRunState,
  TriggerChatRunStore,
} from "./types.js";

type TestServer = {
  url: string;
  close: () => Promise<void>;
};

const activeServers: TestServer[] = [];

afterEach(async function () {
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    if (server) {
      await server.close();
    }
  }
});

describe("TriggerChatTransport", function () {
  it("uses default stream key when stream option is omitted", async function () {
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_default_stream",
        });
        res.end(JSON.stringify({ id: "run_default_stream" }));
        return;
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_default_stream/default") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "default_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "default_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: server.url,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-default-stream",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedStreamPath).toBe("/realtime/v1/streams/run_default_stream/default");
  });

  it("encodes stream key values in stream URL paths", async function () {
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_encoded_stream",
        });
        res.end(JSON.stringify({ id: "run_encoded_stream" }));
        return;
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_encoded_stream/chat%2Fspecial%20stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "encoded_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "encoded_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: server.url,
      stream: "chat/special stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-encoded-stream",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedStreamPath).toBe("/realtime/v1/streams/run_encoded_stream/chat%2Fspecial%20stream");
  });

  it("encodes run IDs in stream URL paths", async function () {
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_encoded_run_id",
        });
        res.end(JSON.stringify({ id: "run/with space" }));
        return;
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run%2Fwith%20space/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "encoded_run_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "encoded_run_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: server.url,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-encoded-run-id",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedStreamPath).toBe("/realtime/v1/streams/run%2Fwith%20space/chat-stream");
  });

  it("normalizes trailing slash in baseURL for stream URLs", async function () {
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_trailing_baseurl",
        });
        res.end(JSON.stringify({ id: "run_trailing_baseurl" }));
        return;
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_trailing_baseurl/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "trailing_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "trailing_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `${server.url}/`,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-trailing-baseurl",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedStreamPath).toBe("/realtime/v1/streams/run_trailing_baseurl/chat-stream");
  });

  it("normalizes repeated trailing slashes in baseURL for trigger and stream URLs", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_multi_trailing_baseurl",
        });
        res.end(JSON.stringify({ id: "run_multi_trailing_baseurl" }));
        return;
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_multi_trailing_baseurl/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "multi_trailing_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "multi_trailing_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `${server.url}///`,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-multi-trailing-baseurl",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe("/realtime/v1/streams/run_multi_trailing_baseurl/chat-stream");
  });

  it("supports baseURL path prefixes for trigger and stream routes", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/custom-base/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_path_prefix",
        });
        res.end(JSON.stringify({ id: "run_path_prefix" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/custom-base/realtime/v1/streams/run_path_prefix/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "path_prefix_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "path_prefix_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `${server.url}/custom-base`,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-path-prefix",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/custom-base/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe("/custom-base/realtime/v1/streams/run_path_prefix/chat-stream");
  });

  it("supports trailing slashes on baseURL path prefixes", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/custom-prefix/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_path_prefix_trailing",
        });
        res.end(JSON.stringify({ id: "run_path_prefix_trailing" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/custom-prefix/realtime/v1/streams/run_path_prefix_trailing/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "path_prefix_trailing_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "path_prefix_trailing_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `${server.url}/custom-prefix///`,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-path-prefix-trailing",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/custom-prefix/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe(
      "/custom-prefix/realtime/v1/streams/run_path_prefix_trailing/chat-stream"
    );
  });

  it("trims surrounding whitespace from baseURL values", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_trimmed_baseurl",
        });
        res.end(JSON.stringify({ id: "run_trimmed_baseurl" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_trimmed_baseurl/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "trimmed_baseurl_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "trimmed_baseurl_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `  ${server.url}/   `,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-trimmed-baseurl",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe("/realtime/v1/streams/run_trimmed_baseurl/chat-stream");
  });

  it("trims newline and tab whitespace around baseURL values", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_trimmed_newline_tab_baseurl",
        });
        res.end(JSON.stringify({ id: "run_trimmed_newline_tab_baseurl" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_trimmed_newline_tab_baseurl/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "trimmed_newline_tab_baseurl_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "trimmed_newline_tab_baseurl_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `\n\t${server.url}/\t\n`,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-trimmed-newline-tab-baseurl",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe("/realtime/v1/streams/run_trimmed_newline_tab_baseurl/chat-stream");
  });

  it("preserves baseURL path prefixes after trimming surrounding whitespace", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/trimmed-prefix/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_trimmed_prefix",
        });
        res.end(JSON.stringify({ id: "run_trimmed_prefix" }));
        return;
      }

      if (req.method === "GET" && req.url === "/trimmed-prefix/realtime/v1/streams/run_trimmed_prefix/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "trimmed_prefix_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "trimmed_prefix_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `  ${server.url}/trimmed-prefix///   `,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-trimmed-prefix-baseurl",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/trimmed-prefix/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe("/trimmed-prefix/realtime/v1/streams/run_trimmed_prefix/chat-stream");
  });

  it("preserves baseURL path prefixes after trimming unicode wrapper whitespace", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/unicode-prefix/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_unicode_prefix",
        });
        res.end(JSON.stringify({ id: "run_unicode_prefix" }));
        return;
      }

      if (req.method === "GET" && req.url === "/unicode-prefix/realtime/v1/streams/run_unicode_prefix/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "unicode_prefix_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "unicode_prefix_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `\u3000${server.url}/unicode-prefix///\u3000`,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-unicode-prefix-baseurl",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/unicode-prefix/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe("/unicode-prefix/realtime/v1/streams/run_unicode_prefix/chat-stream");
  });

  it("throws when baseURL is empty after trimming", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "   ///   ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws when baseURL is empty after trimming non-breaking spaces", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u00A0///\u00A0",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws when baseURL is empty after trimming ogham-space-mark wrappers", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u1680///\u1680",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws when baseURL is empty after trimming ideographic-space wrappers", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u3000///\u3000",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws when baseURL is empty after trimming figure-space wrappers", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2007///\u2007",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws when baseURL is empty after trimming medium-mathematical-space wrappers", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u205F///\u205F",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws internal-whitespace validation for mongolian-vowel-separator wrapper slashes", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u180E///\u180E",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("uses default baseURL when omitted", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("throws when baseURL is not a valid absolute URL", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "not-a-valid-url",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must be a valid absolute URL");
  });

  it("throws when baseURL contains internal whitespace characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\ninternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/in valid",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal non-breaking-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u00A0internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal tab characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\tinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal vertical-tab characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\vinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal form-feed characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\finternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal narrow no-break space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u202Finternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal ogham-space-mark characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u1680internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal ideographic-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u3000internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal figure-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2007internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal medium-mathematical-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u205Finternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal hair-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u200Ainternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal thin-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2009internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal punctuation-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2008internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal six-per-em-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2006internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal mongolian-vowel-separator characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u180Einternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal line-separator characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2028internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal paragraph-separator characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2029internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal carriage-return characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\rinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal zero-width-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u200Binternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL is wrapped with zero-width-space characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u200Bhttps://api.trigger.dev/custom-prefix/\u200B",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL is wrapped with zero-width-non-joiner characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u200Chttps://api.trigger.dev/custom-prefix/\u200C",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL is wrapped with zero-width-joiner characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u200Dhttps://api.trigger.dev/custom-prefix/\u200D",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL is wrapped with mongolian-vowel-separator characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u180Ehttps://api.trigger.dev/custom-prefix/\u180E",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal zero-width-non-joiner characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u200Cinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal zero-width-joiner characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u200Dinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal word-joiner characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2060internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL is wrapped with word-joiner characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2060https://api.trigger.dev/custom-prefix/\u2060",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL contains internal BOM characters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\uFEFFinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws when baseURL is a relative path", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "/relative/path",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must be a valid absolute URL");
  });

  it("throws when baseURL protocol is not http or https", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://example.com",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws when baseURL protocol is ws", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ws://example.com",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws when trimmed baseURL protocol is ws", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  ws://example.com  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws when newline-and-tab wrapped baseURL protocol is ws", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\tws://example.com\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws when baseURL protocol is wss", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "wss://example.com",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws when trimmed baseURL protocol is wss", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  wss://example.com  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws when newline-and-tab wrapped baseURL protocol is wss", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\twss://example.com\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws when baseURL includes query parameters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://example.com/base?query=1",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws when trimmed baseURL includes query parameters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://example.com/base/?query=1  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws when newline-and-tab wrapped baseURL includes query parameters", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\thttps://example.com/base/?query=1\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws query/hash validation after trimming wrapper whitespace", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://api.trigger.dev/base?query=1  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws when baseURL includes hash fragments", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://example.com/base#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws when trimmed baseURL includes hash fragments", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://example.com/base/#fragment  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws when newline-and-tab wrapped baseURL includes hash fragments", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\thttps://example.com/base/#fragment\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws when baseURL includes username or password credentials", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://user:pass@example.com/base",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include username or password credentials");
  });

  it("prioritizes protocol validation over query/hash validation", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://example.com/base?query=1",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("prioritizes protocol validation over query/hash/credential validation", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://user:pass@example.com/base?query=1#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("prioritizes internal-whitespace validation over protocol/query/hash/credential validation", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://user:pass@example.com/in valid?query=1#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("prioritizes invisible-separator validation over protocol/query/hash/credential validation", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://user:pass@example.com/\u2060invalid?query=1#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("prioritizes mongolian-vowel-separator validation over protocol/query/hash/credential validation", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://user:pass@example.com/\u180Einvalid?query=1#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("prioritizes query/hash validation over credential validation", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://user:pass@example.com/base?query=1",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("prioritizes hash validation over credential validation", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://user:pass@example.com/base#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws when trimmed baseURL includes username or password credentials", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://user:pass@example.com/base/  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include username or password credentials");
  });

  it("throws when newline-and-tab wrapped baseURL includes username or password credentials", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\thttps://user:pass@example.com/base/\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include username or password credentials");
  });

  it("accepts https baseURL values without throwing", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/custom-prefix",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts uppercase https protocol in baseURL", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "HTTPS://api.trigger.dev/custom-prefix",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts whitespace-wrapped uppercase https protocol in baseURL", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  HTTPS://api.trigger.dev/custom-prefix///   ",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts newline-and-tab wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\thttps://api.trigger.dev/custom-prefix/\t\n",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts non-breaking-space wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u00A0https://api.trigger.dev/custom-prefix/\u00A0",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts ogham-space-mark wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u1680https://api.trigger.dev/custom-prefix/\u1680",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts figure-space wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2007https://api.trigger.dev/custom-prefix/\u2007",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts medium-mathematical-space wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u205Fhttps://api.trigger.dev/custom-prefix/\u205F",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts hair-space wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u200Ahttps://api.trigger.dev/custom-prefix/\u200A",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts thin-space wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2009https://api.trigger.dev/custom-prefix/\u2009",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts punctuation-space wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2008https://api.trigger.dev/custom-prefix/\u2008",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts six-per-em-space wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2006https://api.trigger.dev/custom-prefix/\u2006",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts ideographic-space wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u3000https://api.trigger.dev/custom-prefix/\u3000",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts BOM-wrapped baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\uFEFFhttps://api.trigger.dev/custom-prefix/\uFEFF",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts BOM-wrapped uppercase HTTP baseURL values", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\uFEFFHTTP://api.trigger.dev/custom-prefix/\uFEFF",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts percent-encoded whitespace in baseURL paths", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/custom%20prefix",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts percent-encoded query and hash markers in baseURL paths", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/custom%3Fprefix%23segment",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts wrapper-whitespace around percent-encoded query/hash markers", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://api.trigger.dev/custom%3Fprefix%23segment///   ",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts whitespace-wrapped uppercase http protocol in baseURL", function () {
    expect(function () {
      new TriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  HTTP://api.trigger.dev/custom-prefix///   ",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts uppercase http protocol in baseURL", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_uppercase_protocol",
        });
        res.end(JSON.stringify({ id: "run_uppercase_protocol" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_uppercase_protocol/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "uppercase_protocol_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "uppercase_protocol_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const uppercasedProtocolBaseUrl = server.url.replace(/^http:\/\//, "HTTP://");

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: uppercasedProtocolBaseUrl,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-uppercase-protocol",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe("/realtime/v1/streams/run_uppercase_protocol/chat-stream");
  });

  it("supports whitespace-wrapped uppercase http protocol with path prefix", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/uppercase-http-prefix/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_uppercase_http_prefix",
        });
        res.end(JSON.stringify({ id: "run_uppercase_http_prefix" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/uppercase-http-prefix/realtime/v1/streams/run_uppercase_http_prefix/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "uppercase_http_prefix_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "uppercase_http_prefix_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const uppercaseHttpBaseUrl = server.url.replace(/^http:\/\//, "HTTP://");

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `  ${uppercaseHttpBaseUrl}/uppercase-http-prefix///   `,
      stream: "chat-stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-uppercase-http-prefix",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/uppercase-http-prefix/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe(
      "/uppercase-http-prefix/realtime/v1/streams/run_uppercase_http_prefix/chat-stream"
    );
  });

  it("combines path prefixes with run and stream URL encoding", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/prefixed/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_prefixed_encoded",
        });
        res.end(JSON.stringify({ id: "run/with space" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url ===
          "/prefixed/realtime/v1/streams/run%2Fwith%20space/chat%2Fspecial%20stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "prefixed_encoded_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "prefixed_encoded_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `${server.url}/prefixed///`,
      stream: "chat/special stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-prefixed-encoded",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/prefixed/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe(
      "/prefixed/realtime/v1/streams/run%2Fwith%20space/chat%2Fspecial%20stream"
    );
  });

  it("combines trimmed baseURL path prefixes with run and stream URL encoding", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/trimmed-prefixed/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_trimmed_prefixed_encoded",
        });
        res.end(JSON.stringify({ id: "run/with space trim" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url ===
          "/trimmed-prefixed/realtime/v1/streams/run%2Fwith%20space%20trim/chat%2Fspecial%20stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "trimmed_prefixed_encoded_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "trimmed_prefixed_encoded_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: `  ${server.url}/trimmed-prefixed///   `,
      stream: "chat/special stream",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-trimmed-prefixed-encoded",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/trimmed-prefixed/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe(
      "/trimmed-prefixed/realtime/v1/streams/run%2Fwith%20space%20trim/chat%2Fspecial%20stream"
    );
  });

  it("uses defined stream object id when provided", async function () {
    let observedStreamPath: string | undefined;

    const streamDefinition = {
      id: "typed-stream-id",
      pipe: async function pipe() {
        throw new Error("not used in this test");
      },
    } as unknown as TriggerChatStream<UIMessage>;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_stream_object",
        });
        res.end(JSON.stringify({ id: "run_stream_object" }));
        return;
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_stream_object/typed-stream-id") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "typed_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "typed_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: "pk_trigger",
      baseURL: server.url,
      stream: streamDefinition,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-typed-stream",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedStreamPath).toBe("/realtime/v1/streams/run_stream_object/typed-stream-id");
  });

  it("forwards preview branch and timeout headers to trigger and stream requests", async function () {
    let triggerBranchHeader: string | undefined;
    let streamBranchHeader: string | undefined;
    let streamTimeoutHeader: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        const branchHeader = req.headers["x-trigger-branch"];
        triggerBranchHeader = Array.isArray(branchHeader) ? branchHeader[0] : branchHeader;

        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_headers",
        });
        res.end(JSON.stringify({ id: "run_headers" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_headers/chat-stream") {
        const branchHeader = req.headers["x-trigger-branch"];
        const timeoutHeader = req.headers["timeout-seconds"];

        streamBranchHeader = Array.isArray(branchHeader) ? branchHeader[0] : branchHeader;
        streamTimeoutHeader = Array.isArray(timeoutHeader) ? timeoutHeader[0] : timeoutHeader;

        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "headers_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "headers_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      previewBranch: "feature-preview",
      timeoutInSeconds: 123,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-headers",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(triggerBranchHeader).toBe("feature-preview");
    expect(streamBranchHeader).toBe("feature-preview");
    expect(streamTimeoutHeader).toBe("123");
  });

  it("triggers task and streams chunks with rich default payload", async function () {
    let receivedTriggerBody: Record<string, unknown> | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        readJsonBody(req).then(function (body) {
          receivedTriggerBody = body;
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_123",
          });
          res.end(JSON.stringify({ id: "run_123" }));
        });
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_123/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "msg_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-delta", id: "msg_1", delta: "Hello" })
        );
        writeSSE(
          res,
          "3-0",
          JSON.stringify({ type: "text-end", id: "msg_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [
        {
          id: "usr_1",
          role: "user",
          parts: [{ type: "text", text: "Hello there" }],
        } satisfies UIMessage,
      ],
      abortSignal: undefined,
      headers: new Headers([["x-test-header", "abc123"]]),
      body: { tenantId: "tenant_1" },
      metadata: { source: "unit-test" },
    });

    const chunks = await readChunks(stream);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      type: "text-start",
      chunk: { type: "text-start", id: "msg_1" },
    });
    expect(chunks[1]).toMatchObject({
      type: "text-delta",
      chunk: { type: "text-delta", id: "msg_1", delta: "Hello" },
    });
    expect(chunks[2]).toMatchObject({
      type: "text-end",
      chunk: { type: "text-end", id: "msg_1" },
    });

    expect(receivedTriggerBody).toBeDefined();

    const options = (receivedTriggerBody?.options ?? {}) as Record<string, unknown>;
    expect(options.payloadType).toBe("application/super+json");

    const payloadString = receivedTriggerBody?.payload as string;
    const payload = (JSON.parse(payloadString) as { json: Record<string, unknown> }).json;

    expect(payload.chatId).toBe("chat-1");
    expect(payload.trigger).toBe("submit-message");
    expect(payload.messageId).toBeNull();
    expect(payload.messages).toHaveLength(1);
    expect(payload.request).toEqual({
      headers: {
        "x-test-header": "abc123",
      },
      body: { tenantId: "tenant_1" },
      metadata: { source: "unit-test" },
    });
  });

  it("normalizes tuple header arrays into request headers", async function () {
    let receivedTriggerBody: Record<string, unknown> | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        readJsonBody(req).then(function (body) {
          receivedTriggerBody = body;
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_tuple_headers",
          });
          res.end(JSON.stringify({ id: "run_tuple_headers" }));
        });
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_tuple_headers/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "tuple_headers_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "tuple_headers_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-tuple-headers",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
      headers: [["x-tuple-header", "tuple-value"]],
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);

    const payloadString = receivedTriggerBody?.payload as string;
    const payload = (JSON.parse(payloadString) as { json: Record<string, unknown> }).json;
    expect(payload.request).toEqual({
      body: null,
      headers: {
        "x-tuple-header": "tuple-value",
      },
      metadata: null,
    });
  });

  it("normalizes header helper input values consistently", function () {
    const originalHeaders = {
      "x-object": "object-value",
    };
    const normalizedObjectHeaders = normalizeTriggerChatHeaders(originalHeaders);
    originalHeaders["x-object"] = "changed";

    expect(normalizeTriggerChatHeaders(undefined)).toBeUndefined();
    expect(normalizedObjectHeaders).toEqual({
      "x-object": "object-value",
    });
    expect(
      normalizeTriggerChatHeaders([["x-array", "array-value"]])
    ).toEqual({
      "x-array": "array-value",
    });
    expect(
      normalizeTriggerChatHeaders([
        ["x-dup", "first"],
        ["x-dup", "second"],
      ])
    ).toEqual({
      "x-dup": "second",
    });
    expect(
      normalizeTriggerChatHeaders(new Headers([["x-headers", "headers-value"]]))
    ).toEqual({
      "x-headers": "headers-value",
    });
  });

  it("returns null on reconnect when no active run exists", async function () {
    const errors: TriggerChatTransportError[] = [];
    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: "https://api.trigger.dev",
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.reconnectToStream({
      chatId: "missing-chat",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(0);
  });

  it("removes inactive run entries during reconnect attempts", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new TrackedRunStore();
    runStore.set({
      chatId: "chat-inactive",
      runId: "run_inactive",
      publicAccessToken: "pk_inactive",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.reconnectToStream({
      chatId: "chat-inactive",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(0);
    expect(runStore.deleteCalls).toContain("chat-inactive");
    expect(runStore.get("chat-inactive")).toBeUndefined();
  });

  it("reports inactive reconnect cleanup delete failures through onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteRunStore(1);
    runStore.set({
      chatId: "chat-inactive-delete-failure",
      runId: "run_inactive_delete_failure",
      publicAccessToken: "pk_inactive_delete_failure",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-failure",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-inactive-delete-failure",
      runId: "run_inactive_delete_failure",
    });
    expect(errors[0]?.error.message).toBe("cleanup delete failed");
  });

  it("does not attempt reconnect stream fetch for inactive run cleanup failures", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteRunStore(1);
    runStore.set({
      chatId: "chat-inactive-no-fetch",
      runId: "run_inactive_no_fetch",
      publicAccessToken: "pk_inactive_no_fetch",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    let fetchAttempted = false;
    (transport as any).fetchRunStream = async function fetchRunStream() {
      fetchAttempted = true;
      throw new Error("unexpected reconnect fetch");
    };

    const stream = await transport.reconnectToStream({
      chatId: "chat-inactive-no-fetch",
    });

    expect(stream).toBeNull();
    expect(fetchAttempted).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-inactive-no-fetch",
      runId: "run_inactive_no_fetch",
    });
    expect(errors[0]?.error.message).toBe("cleanup delete failed");
  });

  it("retries inactive cleanup and reports each persistent delete failure", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new AlwaysFailCleanupDeleteRunStore();
    runStore.set({
      chatId: "chat-inactive-delete-always-fails",
      runId: "run_inactive_delete_always_fails",
      publicAccessToken: "pk_inactive_delete_always_fails",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    let fetchCalls = 0;
    (transport as any).fetchRunStream = async function fetchRunStream() {
      fetchCalls += 1;
      throw new Error("unexpected reconnect fetch");
    };

    const firstReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-always-fails",
    });
    const secondReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-always-fails",
    });

    expect(firstReconnect).toBeNull();
    expect(secondReconnect).toBeNull();
    expect(fetchCalls).toBe(0);
    expect(runStore.deleteCallCount).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-inactive-delete-always-fails",
      runId: "run_inactive_delete_always_fails",
    });
    expect(errors[1]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-inactive-delete-always-fails",
      runId: "run_inactive_delete_always_fails",
    });
    expect(errors[0]?.error.message).toBe("cleanup delete always fails");
    expect(errors[1]?.error.message).toBe("cleanup delete always fails");
  });

  it("retries inactive reconnect cleanup on subsequent reconnect attempts", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteRunStore(1);
    runStore.set({
      chatId: "chat-inactive-delete-retry",
      runId: "run_inactive_delete_retry",
      publicAccessToken: "pk_inactive_delete_retry",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const firstReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-retry",
    });

    expect(firstReconnect).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-inactive-delete-retry",
      runId: "run_inactive_delete_retry",
    });
    expect(runStore.get("chat-inactive-delete-retry")).toMatchObject({
      isActive: false,
    });

    const secondReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-retry",
    });

    expect(secondReconnect).toBeNull();
    expect(errors).toHaveLength(1);
    expect(runStore.get("chat-inactive-delete-retry")).toBeUndefined();
  });

  it("returns null when inactive reconnect cleanup delete and onError both fail", async function () {
    const runStore = new FailingCleanupDeleteRunStore(1);
    runStore.set({
      chatId: "chat-inactive-delete-onerror-failure",
      runId: "run_inactive_delete_onerror_failure",
      publicAccessToken: "pk_inactive_delete_onerror_failure",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: async function onError() {
        throw new Error("onError failed");
      },
    });

    const stream = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-onerror-failure",
    });

    expect(stream).toBeNull();
  });

  it("returns null when inactive reconnect cleanup delete fails without onError callback", async function () {
    const runStore = new FailingCleanupDeleteRunStore(1);
    runStore.set({
      chatId: "chat-inactive-delete-no-onerror",
      runId: "run_inactive_delete_no_onerror",
      publicAccessToken: "pk_inactive_delete_no_onerror",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
    });

    const stream = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-no-onerror",
    });

    expect(stream).toBeNull();
  });

  it("returns null on repeated inactive cleanup failures without onError callback", async function () {
    const runStore = new AlwaysFailCleanupDeleteRunStore();
    runStore.set({
      chatId: "chat-inactive-delete-always-no-onerror",
      runId: "run_inactive_delete_always_no_onerror",
      publicAccessToken: "pk_inactive_delete_always_no_onerror",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
    });

    let fetchCalls = 0;
    (transport as any).fetchRunStream = async function fetchRunStream() {
      fetchCalls += 1;
      throw new Error("unexpected reconnect fetch");
    };

    const firstReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-always-no-onerror",
    });
    const secondReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-always-no-onerror",
    });

    expect(firstReconnect).toBeNull();
    expect(secondReconnect).toBeNull();
    expect(fetchCalls).toBe(0);
    expect(runStore.deleteCallCount).toBe(2);
    expect(runStore.get("chat-inactive-delete-always-no-onerror")).toMatchObject({
      isActive: false,
    });
  });

  it("returns null when inactive reconnect string cleanup delete fails without onError callback", async function () {
    const runStore = new FailingCleanupDeleteValueRunStore("cleanup delete string failure");
    runStore.set({
      chatId: "chat-inactive-delete-string-no-onerror",
      runId: "run_inactive_delete_string_no_onerror",
      publicAccessToken: "pk_inactive_delete_string_no_onerror",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
    });

    const stream = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-string-no-onerror",
    });

    expect(stream).toBeNull();
  });

  it("retries inactive reconnect string cleanup without onError callback", async function () {
    const runStore = new FailingCleanupDeleteValueRunStore("cleanup delete string failure");
    runStore.set({
      chatId: "chat-inactive-delete-string-retry-no-onerror",
      runId: "run_inactive_delete_string_retry_no_onerror",
      publicAccessToken: "pk_inactive_delete_string_retry_no_onerror",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
    });

    let fetchCalls = 0;
    (transport as any).fetchRunStream = async function fetchRunStream() {
      fetchCalls += 1;
      throw new Error("unexpected reconnect fetch");
    };

    const firstReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-string-retry-no-onerror",
    });

    expect(firstReconnect).toBeNull();
    expect(fetchCalls).toBe(0);
    expect(runStore.deleteCallCount).toBe(1);
    expect(runStore.get("chat-inactive-delete-string-retry-no-onerror")).toMatchObject({
      isActive: false,
    });

    const secondReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-string-retry-no-onerror",
    });

    expect(secondReconnect).toBeNull();
    expect(fetchCalls).toBe(0);
    expect(runStore.deleteCallCount).toBe(2);
    expect(runStore.get("chat-inactive-delete-string-retry-no-onerror")).toBeUndefined();
  });

  it("retries inactive reconnect string cleanup on subsequent reconnect attempts", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteValueRunStore("cleanup delete string failure");
    runStore.set({
      chatId: "chat-inactive-delete-string-retry",
      runId: "run_inactive_delete_string_retry",
      publicAccessToken: "pk_inactive_delete_string_retry",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const firstReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-string-retry",
    });

    expect(firstReconnect).toBeNull();
    expect(errors).toHaveLength(1);
    expect(runStore.deleteCallCount).toBe(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-inactive-delete-string-retry",
      runId: "run_inactive_delete_string_retry",
    });
    expect(runStore.get("chat-inactive-delete-string-retry")).toMatchObject({
      isActive: false,
    });

    const secondReconnect = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-string-retry",
    });

    expect(secondReconnect).toBeNull();
    expect(errors).toHaveLength(1);
    expect(runStore.deleteCallCount).toBe(2);
    expect(runStore.get("chat-inactive-delete-string-retry")).toBeUndefined();
  });

  it("normalizes non-Error inactive reconnect cleanup delete failures through onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteValueRunStore("cleanup delete string failure");
    runStore.set({
      chatId: "chat-inactive-delete-string-failure",
      runId: "run_inactive_delete_string_failure",
      publicAccessToken: "pk_inactive_delete_string_failure",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-string-failure",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-inactive-delete-string-failure",
      runId: "run_inactive_delete_string_failure",
    });
    expect(errors[0]?.error.message).toBe("cleanup delete string failure");
  });

  it("normalizes object inactive reconnect cleanup delete failures through onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteValueRunStore({
      reason: "cleanup delete object failure",
    });
    runStore.set({
      chatId: "chat-inactive-delete-object-failure",
      runId: "run_inactive_delete_object_failure",
      publicAccessToken: "pk_inactive_delete_object_failure",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-object-failure",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-inactive-delete-object-failure",
      runId: "run_inactive_delete_object_failure",
    });
    expect(errors[0]?.error.message).toBe("[object Object]");
  });

  it("returns null when inactive reconnect string cleanup delete and onError both fail", async function () {
    const runStore = new FailingCleanupDeleteValueRunStore("cleanup delete string failure");
    runStore.set({
      chatId: "chat-inactive-delete-string-onerror-failure",
      runId: "run_inactive_delete_string_onerror_failure",
      publicAccessToken: "pk_inactive_delete_string_onerror_failure",
      streamKey: "chat-stream",
      lastEventId: "10-0",
      isActive: false,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: async function onError() {
        throw new Error("onError failed");
      },
    });

    const stream = await transport.reconnectToStream({
      chatId: "chat-inactive-delete-string-onerror-failure",
    });

    expect(stream).toBeNull();
  });

  it("supports custom payload mapping and trigger options resolver", async function () {
    let receivedTriggerBody: Record<string, unknown> | undefined;
    let receivedResolverChatId: string | undefined;
    let receivedResolverHeader: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        readJsonBody(req).then(function (body) {
          receivedTriggerBody = body;
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_789",
          });
          res.end(JSON.stringify({ id: "run_789" }));
        });
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_789/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "mapped_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "mapped_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport<
      UIMessage,
      {
        prompt: string;
        chatId: string;
        sourceHeader: string | undefined;
      }
    >({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      payloadMapper: async function payloadMapper(request) {
        await sleep(1);

        const firstMessage = request.messages[0];
        const firstPart = firstMessage?.parts[0];
        const prompt =
          firstPart && firstPart.type === "text"
            ? firstPart.text
            : "";

        return {
          prompt,
          chatId: request.chatId,
          sourceHeader: request.request.headers?.["x-source"],
        };
      },
      triggerOptions: async function triggerOptions(request) {
        await sleep(1);

        receivedResolverChatId = request.chatId;
        receivedResolverHeader = request.request.headers?.["x-source"];

        return {
          queue: "chat-queue",
          concurrencyKey: `chat-${request.chatId}`,
          idempotencyKey: `idem-${request.chatId}`,
          ttl: "30m",
          tags: ["chat", "mapped"],
          metadata: {
            requester: request.request.headers?.["x-source"] ?? "unknown",
          },
          priority: 50,
        };
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-mapped",
      messageId: undefined,
      messages: [
        {
          id: "mapped-user",
          role: "user",
          parts: [{ type: "text", text: "Map me" }],
        } satisfies UIMessage,
      ],
      abortSignal: undefined,
      headers: {
        "x-source": "sdk-test",
      },
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      chunk: { type: "text-start", id: "mapped_1" },
    });
    expect(chunks[1]).toMatchObject({
      chunk: { type: "text-end", id: "mapped_1" },
    });

    expect(receivedResolverChatId).toBe("chat-mapped");
    expect(receivedResolverHeader).toBe("sdk-test");

    expect(receivedTriggerBody).toBeDefined();
    const payloadString = receivedTriggerBody?.payload as string;
    const payload = (JSON.parse(payloadString) as { json: Record<string, unknown> }).json;
    expect(payload).toEqual({
      prompt: "Map me",
      chatId: "chat-mapped",
      sourceHeader: "sdk-test",
    });

    const options = (receivedTriggerBody?.options ?? {}) as Record<string, unknown>;
    expect(options.queue).toEqual({ name: "chat-queue" });
    expect(options.concurrencyKey).toBe("chat-chat-mapped");
    expect(options.ttl).toBe("30m");
    expect(options.tags).toEqual(["chat", "mapped"]);
    expect(options.metadata).toEqual({ requester: "sdk-test" });
    expect(options.priority).toBe(50);
    expect(typeof options.idempotencyKey).toBe("string");
    expect((options.idempotencyKey as string).length).toBe(64);
  });

  it("supports static trigger options objects", async function () {
    let receivedTriggerBody: Record<string, unknown> | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        readJsonBody(req).then(function (body) {
          receivedTriggerBody = body;
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_static_opts",
          });
          res.end(JSON.stringify({ id: "run_static_opts" }));
        });
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_static_opts/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "static_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "static_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      triggerOptions: {
        queue: "static-queue",
        concurrencyKey: "chat-static",
        idempotencyKey: "static-idempotency",
        metadata: {
          mode: "static",
        },
        maxAttempts: 2,
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-static-options",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);

    const options = (receivedTriggerBody?.options ?? {}) as Record<string, unknown>;
    expect(options.queue).toEqual({ name: "static-queue" });
    expect(options.concurrencyKey).toBe("chat-static");
    expect(options.metadata).toEqual({ mode: "static" });
    expect(options.maxAttempts).toBe(2);
    expect(typeof options.idempotencyKey).toBe("string");
    expect((options.idempotencyKey as string).length).toBe(64);
  });

  it("surfaces payload mapper errors and does not trigger runs", async function () {
    let triggerCalls = 0;
    const errors: TriggerChatTransportError[] = [];

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        triggerCalls++;
      }

      res.writeHead(500, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: "unexpected" }));
    });

    const transport = new TriggerChatTransport<
      UIMessage,
      { prompt: string }
    >({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      payloadMapper: async function payloadMapper() {
        throw new Error("mapper failed");
      },
      onError: function onError(error) {
        errors.push(error);
      },
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-mapper-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("mapper failed");

    expect(triggerCalls).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "payloadMapper",
      chatId: "chat-mapper-failure",
      runId: undefined,
    });
    expect(errors[0]?.error.message).toBe("mapper failed");
  });

  it("normalizes non-Error mapper failures before reporting onError", async function () {
    const errors: TriggerChatTransportError[] = [];

    const transport = new TriggerChatTransport<
      UIMessage,
      { prompt: string }
    >({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      payloadMapper: async function payloadMapper() {
        throw "string mapper failure";
      },
      onError: function onError(error) {
        errors.push(error);
      },
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-mapper-string-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toBe("string mapper failure");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "payloadMapper",
      chatId: "chat-mapper-string-failure",
      runId: undefined,
    });
    expect(errors[0]?.error.message).toBe("string mapper failure");
  });

  it("keeps original mapper failure when onError callback also fails", async function () {
    const transport = new TriggerChatTransport<
      UIMessage,
      { prompt: string }
    >({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      payloadMapper: async function payloadMapper() {
        throw new Error("mapper failed root");
      },
      onError: async function onError() {
        throw new Error("onError failed");
      },
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-mapper-onerror-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("mapper failed root");
  });

  it("surfaces trigger options resolver errors and does not trigger runs", async function () {
    let triggerCalls = 0;
    const errors: TriggerChatTransportError[] = [];

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        triggerCalls++;
      }

      res.writeHead(500, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: "unexpected" }));
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      triggerOptions: async function triggerOptions() {
        throw new Error("trigger options failed");
      },
      onError: function onError(error) {
        errors.push(error);
      },
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-trigger-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("trigger options failed");

    expect(triggerCalls).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "triggerOptions",
      chatId: "chat-trigger-failure",
      runId: undefined,
    });
    expect(errors[0]?.error.message).toBe("trigger options failed");
  });

  it("normalizes non-Error trigger options failures before reporting onError", async function () {
    const errors: TriggerChatTransportError[] = [];

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      triggerOptions: async function triggerOptions() {
        throw "string trigger options failure";
      },
      onError: function onError(error) {
        errors.push(error);
      },
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-trigger-string-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toBe("string trigger options failure");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "triggerOptions",
      chatId: "chat-trigger-string-failure",
      runId: undefined,
    });
    expect(errors[0]?.error.message).toBe("string trigger options failure");
  });

  it("keeps original trigger options failure when onError callback also fails", async function () {
    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      triggerOptions: async function triggerOptions() {
        throw new Error("trigger options failed root");
      },
      onError: async function onError() {
        throw new Error("onError failed");
      },
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-trigger-options-onerror-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("trigger options failed root");
  });

  it("reports trigger task request failures through onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const server = await startServer(function (_req, res) {
      res.writeHead(500, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: "task trigger failed" }));
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      requestOptions: {
        retry: {
          maxAttempts: 1,
          minTimeoutInMs: 1,
          maxTimeoutInMs: 1,
          factor: 1,
          randomize: false,
        },
      },
      onError: function onError(error) {
        errors.push(error);
      },
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-trigger-request-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("task trigger failed");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "triggerTask",
      chatId: "chat-trigger-request-failure",
      runId: undefined,
    });
  });

  it("normalizes non-Error trigger task failures before reporting onError", async function () {
    const errors: TriggerChatTransportError[] = [];

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).triggerTask = async function triggerTask() {
      throw "string trigger task failure";
    };

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-trigger-task-string-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toBe("string trigger task failure");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "triggerTask",
      chatId: "chat-trigger-task-string-failure",
      runId: undefined,
    });
    expect(errors[0]?.error.message).toBe("string trigger task failure");
  });

  it("keeps original trigger task failure when onError callback also fails", async function () {
    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      onError: async function onError() {
        throw new Error("onError failed");
      },
    });

    (transport as any).triggerTask = async function triggerTask() {
      throw new Error("trigger task failed root");
    };

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-trigger-task-onerror-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("trigger task failed root");
  });

  it("reports stream subscription failures through onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new TrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_stream_subscribe_error",
        });
        res.end(JSON.stringify({ id: "run_stream_subscribe_error" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("stream subscribe failed root");
    };

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-stream-subscribe-error",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("stream subscribe failed root");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "streamSubscribe",
      chatId: "chat-stream-subscribe-error",
      runId: "run_stream_subscribe_error",
    });
    expect(errors[0]?.error.message).toBe("stream subscribe failed root");
    expect(runStore.setSnapshots).toHaveLength(2);
    expect(runStore.setSnapshots[0]).toMatchObject({
      chatId: "chat-stream-subscribe-error",
      runId: "run_stream_subscribe_error",
      isActive: true,
    });
    expect(runStore.setSnapshots[1]).toMatchObject({
      chatId: "chat-stream-subscribe-error",
      runId: "run_stream_subscribe_error",
      isActive: false,
    });
    expect(runStore.deleteCalls).toEqual(["chat-stream-subscribe-error"]);
    expect(runStore.get("chat-stream-subscribe-error")).toBeUndefined();
  });

  it("normalizes non-Error stream subscription failures before reporting onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new TrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_stream_subscribe_string_error",
        });
        res.end(JSON.stringify({ id: "run_stream_subscribe_string_error" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw "stream subscribe string failure";
    };

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-stream-subscribe-string-error",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toBe("stream subscribe string failure");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "streamSubscribe",
      chatId: "chat-stream-subscribe-string-error",
      runId: "run_stream_subscribe_string_error",
    });
    expect(errors[0]?.error.message).toBe("stream subscribe string failure");
    expect(runStore.setSnapshots).toHaveLength(2);
    expect(runStore.setSnapshots[0]).toMatchObject({
      chatId: "chat-stream-subscribe-string-error",
      runId: "run_stream_subscribe_string_error",
      isActive: true,
    });
    expect(runStore.setSnapshots[1]).toMatchObject({
      chatId: "chat-stream-subscribe-string-error",
      runId: "run_stream_subscribe_string_error",
      isActive: false,
    });
    expect(runStore.deleteCalls).toEqual(["chat-stream-subscribe-string-error"]);
    expect(runStore.get("chat-stream-subscribe-string-error")).toBeUndefined();
  });

  it("keeps original stream subscription failure when onError callback also fails", async function () {
    const runStore = new InMemoryTriggerChatRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_stream_subscribe_onerror_failure",
        });
        res.end(JSON.stringify({ id: "run_stream_subscribe_onerror_failure" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: async function onError() {
        throw new Error("onError failed");
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("stream subscribe failed root");
    };

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-stream-subscribe-onerror-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("stream subscribe failed root");

    expect(runStore.get("chat-stream-subscribe-onerror-failure")).toBeUndefined();
  });

  it(
    "keeps original non-Error stream subscription failure when onError callback also fails",
    async function () {
      const runStore = new InMemoryTriggerChatRunStore();

      const server = await startServer(function (req, res) {
        if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_stream_subscribe_string_onerror_failure",
          });
          res.end(JSON.stringify({ id: "run_stream_subscribe_string_onerror_failure" }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      const transport = new TriggerChatTransport({
        task: "chat-task",
        stream: "chat-stream",
        accessToken: "pk_trigger",
        baseURL: server.url,
        runStore,
        onError: async function onError() {
          throw new Error("onError failed");
        },
      });

      (transport as any).fetchRunStream = async function fetchRunStream() {
        throw "stream subscribe string root";
      };

      await expect(
        transport.sendMessages({
          trigger: "submit-message",
          chatId: "chat-stream-subscribe-string-onerror-failure",
          messageId: undefined,
          messages: [],
          abortSignal: undefined,
        })
      ).rejects.toBe("stream subscribe string root");

      expect(runStore.get("chat-stream-subscribe-string-onerror-failure")).toBeUndefined();
    }
  );

  it("preserves stream subscribe failures when cleanup run-store set throws", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupSetRunStore(2);

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_stream_subscribe_cleanup_set_failure",
        });
        res.end(JSON.stringify({ id: "run_stream_subscribe_cleanup_set_failure" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("stream subscribe root cause");
    };

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-stream-subscribe-cleanup-set-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("stream subscribe root cause");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "streamSubscribe",
      chatId: "chat-stream-subscribe-cleanup-set-failure",
      runId: "run_stream_subscribe_cleanup_set_failure",
    });
    expect(errors[0]?.error.message).toBe("stream subscribe root cause");
    expect(runStore.deleteCalls).toContain("chat-stream-subscribe-cleanup-set-failure");
    expect(runStore.get("chat-stream-subscribe-cleanup-set-failure")).toBeUndefined();
  });

  it("preserves stream subscribe failures when cleanup run-store delete throws", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteRunStore(1);

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_stream_subscribe_cleanup_delete_failure",
        });
        res.end(JSON.stringify({ id: "run_stream_subscribe_cleanup_delete_failure" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("stream subscribe root cause");
    };

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-stream-subscribe-cleanup-delete-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("stream subscribe root cause");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "streamSubscribe",
      chatId: "chat-stream-subscribe-cleanup-delete-failure",
      runId: "run_stream_subscribe_cleanup_delete_failure",
    });
    expect(errors[0]?.error.message).toBe("stream subscribe root cause");
  });

  it("attempts both cleanup steps when set and delete both throw", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupSetAndDeleteRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_stream_subscribe_cleanup_both_failure",
        });
        res.end(JSON.stringify({ id: "run_stream_subscribe_cleanup_both_failure" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("stream subscribe root cause");
    };

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-stream-subscribe-cleanup-both-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("stream subscribe root cause");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "streamSubscribe",
      chatId: "chat-stream-subscribe-cleanup-both-failure",
      runId: "run_stream_subscribe_cleanup_both_failure",
    });
    expect(runStore.setCalls).toContain("chat-stream-subscribe-cleanup-both-failure");
    expect(runStore.deleteCalls).toContain("chat-stream-subscribe-cleanup-both-failure");
  });

  it(
    "preserves stream subscribe root failures when cleanup and onError callbacks both fail",
    async function () {
      const runStore = new FailingCleanupSetRunStore(2);

      const server = await startServer(function (req, res) {
        if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_stream_subscribe_cleanup_and_onerror_failure",
          });
          res.end(JSON.stringify({ id: "run_stream_subscribe_cleanup_and_onerror_failure" }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      const transport = new TriggerChatTransport({
        task: "chat-task",
        stream: "chat-stream",
        accessToken: "pk_trigger",
        baseURL: server.url,
        runStore,
        onError: async function onError() {
          throw new Error("onError failed");
        },
      });

      (transport as any).fetchRunStream = async function fetchRunStream() {
        throw new Error("stream subscribe root cause");
      };

      await expect(
        transport.sendMessages({
          trigger: "submit-message",
          chatId: "chat-stream-subscribe-cleanup-and-onerror-failure",
          messageId: undefined,
          messages: [],
          abortSignal: undefined,
        })
      ).rejects.toThrowError("stream subscribe root cause");
    }
  );

  it("cleans up async run-store state when stream subscription fails", async function () {
    const runStore = new AsyncTrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_stream_subscribe_async_failure",
        });
        res.end(JSON.stringify({ id: "run_stream_subscribe_async_failure" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("stream subscribe async failure");
    };

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-stream-subscribe-async-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    ).rejects.toThrowError("stream subscribe async failure");

    expect(runStore.setCalls).toEqual([
      "chat-stream-subscribe-async-failure",
      "chat-stream-subscribe-async-failure",
    ]);
    expect(runStore.deleteCalls).toEqual(["chat-stream-subscribe-async-failure"]);
    await expect(
      runStore.get("chat-stream-subscribe-async-failure")
    ).resolves.toBeUndefined();
  });

  it("supports creating transport with factory function", async function () {
    let observedRunId: string | undefined;
    let callbackCompleted = false;
    let observedState: TriggerChatRunState | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_factory",
        });
        res.end(JSON.stringify({ id: "run_factory" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_factory/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "factory_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "factory_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = createTriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      onTriggeredRun: async function onTriggeredRun(state) {
        await sleep(1);
        observedRunId = state.runId;
        observedState = state;
        callbackCompleted = true;
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-factory",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedRunId).toBe("run_factory");
    expect(callbackCompleted).toBe(true);
    expect(observedState).toMatchObject({
      chatId: "chat-factory",
      runId: "run_factory",
      streamKey: "chat-stream",
      lastEventId: undefined,
      isActive: true,
    });
  });

  it("supports creating transport with factory function and unicode-wrapped baseURL path prefixes", async function () {
    let observedTriggerPath: string | undefined;
    let observedStreamPath: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST") {
        observedTriggerPath = req.url ?? "";
      }

      if (req.method === "GET") {
        observedStreamPath = req.url ?? "";
      }

      if (req.method === "POST" && req.url === "/factory-unicode-prefix/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_factory_unicode_prefix",
        });
        res.end(JSON.stringify({ id: "run_factory_unicode_prefix" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/factory-unicode-prefix/realtime/v1/streams/run_factory_unicode_prefix/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "factory_unicode_prefix_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "factory_unicode_prefix_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = createTriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: `\u3000${server.url}/factory-unicode-prefix///\u3000`,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-factory-unicode-prefix",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedTriggerPath).toBe("/factory-unicode-prefix/api/v1/tasks/chat-task/trigger");
    expect(observedStreamPath).toBe("/factory-unicode-prefix/realtime/v1/streams/run_factory_unicode_prefix/chat-stream");
  });

  it("throws from factory when baseURL is empty after trimming", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "   ///   ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws from factory when baseURL is empty after trimming non-breaking spaces", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u00A0///\u00A0",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws from factory when baseURL is empty after trimming ogham-space-mark wrappers", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u1680///\u1680",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws from factory when baseURL is empty after trimming ideographic-space wrappers", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u3000///\u3000",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws from factory when baseURL is empty after trimming figure-space wrappers", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2007///\u2007",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws from factory when baseURL is empty after trimming medium-mathematical-space wrappers", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u205F///\u205F",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not be empty");
  });

  it("throws internal-whitespace validation from factory for mongolian-vowel-separator wrapper slashes", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u180E///\u180E",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("uses default baseURL in factory when omitted", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("throws from factory when baseURL is not a valid absolute URL", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "invalid-base-url",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must be a valid absolute URL");
  });

  it("throws from factory when baseURL contains internal whitespace characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\ninternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/in valid",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal non-breaking-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u00A0internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal tab characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\tinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal vertical-tab characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\vinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal form-feed characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\finternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal narrow no-break space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u202Finternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal ogham-space-mark characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u1680internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal ideographic-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u3000internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal figure-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2007internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal medium-mathematical-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u205Finternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal hair-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u200Ainternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal thin-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2009internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal punctuation-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2008internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal six-per-em-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2006internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal mongolian-vowel-separator characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u180Einternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal line-separator characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2028internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal paragraph-separator characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2029internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal carriage-return characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\rinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal zero-width-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u200Binternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL is wrapped with zero-width-space characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u200Bhttps://api.trigger.dev/custom-prefix/\u200B",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL is wrapped with zero-width-non-joiner characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u200Chttps://api.trigger.dev/custom-prefix/\u200C",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL is wrapped with zero-width-joiner characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u200Dhttps://api.trigger.dev/custom-prefix/\u200D",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL is wrapped with mongolian-vowel-separator characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u180Ehttps://api.trigger.dev/custom-prefix/\u180E",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal zero-width-non-joiner characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u200Cinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal zero-width-joiner characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u200Dinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal word-joiner characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\u2060internal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL is wrapped with word-joiner characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2060https://api.trigger.dev/custom-prefix/\u2060",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL contains internal BOM characters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/\uFEFFinternal",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("throws from factory when baseURL protocol is not http or https", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://example.com",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws from factory when baseURL protocol is ws", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ws://example.com",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws from factory when trimmed baseURL protocol is ws", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  ws://example.com  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws from factory when newline-and-tab wrapped baseURL protocol is ws", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\tws://example.com\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws from factory when baseURL protocol is wss", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "wss://example.com",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws from factory when trimmed baseURL protocol is wss", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  wss://example.com  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws from factory when newline-and-tab wrapped baseURL protocol is wss", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\twss://example.com\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("throws from factory when baseURL includes query parameters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://example.com/base?query=1",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws from factory when trimmed baseURL includes query parameters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://example.com/base/?query=1  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws from factory when newline-and-tab wrapped baseURL includes query parameters", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\thttps://example.com/base/?query=1\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws query/hash validation after trimming wrapper whitespace in factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://api.trigger.dev/base?query=1  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws from factory when baseURL includes hash fragments", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://example.com/base#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws from factory when trimmed baseURL includes hash fragments", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://example.com/base/#fragment  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws from factory when newline-and-tab wrapped baseURL includes hash fragments", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\thttps://example.com/base/#fragment\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws from factory when baseURL includes username or password credentials", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://user:pass@example.com/base",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include username or password credentials");
  });

  it("prioritizes protocol validation over query/hash validation in factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://example.com/base?query=1",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("prioritizes protocol validation over query/hash/credential validation in factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://user:pass@example.com/base?query=1#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must use http or https protocol");
  });

  it("prioritizes internal-whitespace validation over protocol/query/hash/credential validation in factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://user:pass@example.com/in valid?query=1#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("prioritizes invisible-separator validation over protocol/query/hash/credential validation in factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://user:pass@example.com/\u2060invalid?query=1#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("prioritizes mongolian-vowel-separator validation over protocol/query/hash/credential validation in factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "ftp://user:pass@example.com/\u180Einvalid?query=1#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not contain internal whitespace characters");
  });

  it("prioritizes query/hash validation over credential validation in factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://user:pass@example.com/base?query=1",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("prioritizes hash validation over credential validation in factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://user:pass@example.com/base#fragment",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include query parameters or hash fragments");
  });

  it("throws from factory when trimmed baseURL includes username or password credentials", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://user:pass@example.com/base/  ",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include username or password credentials");
  });

  it("throws from factory when newline-and-tab wrapped baseURL includes username or password credentials", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\thttps://user:pass@example.com/base/\t\n",
        stream: "chat-stream",
      });
    }).toThrowError("baseURL must not include username or password credentials");
  });

  it("accepts https baseURL values from factory without throwing", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/custom-prefix",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts uppercase https protocol from factory without throwing", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "HTTPS://api.trigger.dev/custom-prefix",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts whitespace-wrapped uppercase https protocol from factory without throwing", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  HTTPS://api.trigger.dev/custom-prefix///   ",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts newline-and-tab wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\n\thttps://api.trigger.dev/custom-prefix/\t\n",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts non-breaking-space wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u00A0https://api.trigger.dev/custom-prefix/\u00A0",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts ogham-space-mark wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u1680https://api.trigger.dev/custom-prefix/\u1680",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts figure-space wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2007https://api.trigger.dev/custom-prefix/\u2007",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts medium-mathematical-space wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u205Fhttps://api.trigger.dev/custom-prefix/\u205F",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts hair-space wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u200Ahttps://api.trigger.dev/custom-prefix/\u200A",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts thin-space wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2009https://api.trigger.dev/custom-prefix/\u2009",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts punctuation-space wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2008https://api.trigger.dev/custom-prefix/\u2008",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts six-per-em-space wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u2006https://api.trigger.dev/custom-prefix/\u2006",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts ideographic-space wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\u3000https://api.trigger.dev/custom-prefix/\u3000",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts BOM-wrapped baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\uFEFFhttps://api.trigger.dev/custom-prefix/\uFEFF",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts BOM-wrapped uppercase HTTP baseURL values from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "\uFEFFHTTP://api.trigger.dev/custom-prefix/\uFEFF",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts percent-encoded whitespace in baseURL paths from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/custom%20prefix",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts percent-encoded query and hash markers in baseURL paths from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "https://api.trigger.dev/custom%3Fprefix%23segment",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts wrapper-whitespace around percent-encoded query/hash markers from factory", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  https://api.trigger.dev/custom%3Fprefix%23segment///   ",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts uppercase http protocol from factory without throwing", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "HTTP://api.trigger.dev/custom-prefix",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("accepts whitespace-wrapped uppercase http protocol from factory without throwing", function () {
    expect(function () {
      createTriggerChatTransport({
        task: "chat-task",
        accessToken: "pk_trigger",
        baseURL: "  HTTP://api.trigger.dev/custom-prefix///   ",
        stream: "chat-stream",
      });
    }).not.toThrow();
  });

  it("continues streaming when onTriggeredRun callback throws", async function () {
    let callbackCalled = false;
    const errors: TriggerChatTransportError[] = [];

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_callback_error",
        });
        res.end(JSON.stringify({ id: "run_callback_error" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_callback_error/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "callback_error_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "callback_error_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      onTriggeredRun: async function onTriggeredRun() {
        callbackCalled = true;
        throw new Error("callback failed");
      },
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-callback-error",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(callbackCalled).toBe(true);
    expect(chunks).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "onTriggeredRun",
      chatId: "chat-callback-error",
      runId: "run_callback_error",
    });
    expect(errors[0]?.error.message).toBe("callback failed");
  });

  it("does not call onError during successful trigger and stream flows", async function () {
    const errors: TriggerChatTransportError[] = [];
    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_no_error_callback",
        });
        res.end(JSON.stringify({ id: "run_no_error_callback" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_no_error_callback/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "no_error_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "no_error_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-no-error-callback",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it("normalizes non-Error onTriggeredRun failures before reporting onError", async function () {
    const errors: TriggerChatTransportError[] = [];

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_callback_string",
        });
        res.end(JSON.stringify({ id: "run_callback_string" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_callback_string/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "callback_string_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "callback_string_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      onTriggeredRun: async function onTriggeredRun() {
        throw "callback string failure";
      },
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-callback-string",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "onTriggeredRun",
      chatId: "chat-callback-string",
      runId: "run_callback_string",
    });
    expect(errors[0]?.error.message).toBe("callback string failure");
  });

  it("ignores failures from onError callback", async function () {
    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_onerror_fail",
        });
        res.end(JSON.stringify({ id: "run_onerror_fail" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_onerror_fail/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "onerror_fail_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "onerror_fail_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      onTriggeredRun: async function onTriggeredRun() {
        throw new Error("callback failed");
      },
      onError: async function onError() {
        throw new Error("onError failed");
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-onerror-fail",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
  });

  it("reports consumeTrackingStream failures through onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new TrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_tracking_error",
        });
        res.end(JSON.stringify({ id: "run_tracking_error" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      return new ReadableStream({
        start(controller) {
          controller.error(new Error("tracking failed root cause"));
        },
      });
    };

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-tracking-error",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    await expect(readChunks(stream)).rejects.toThrowError("tracking failed root cause");

    await waitForCondition(function () {
      return errors.length === 1;
    });

    expect(errors[0]).toMatchObject({
      phase: "consumeTrackingStream",
      chatId: "chat-tracking-error",
      runId: "run_tracking_error",
    });
    expect(errors[0]?.error.message).toBe("tracking failed root cause");
    expect(runStore.get("chat-tracking-error")).toBeUndefined();
  });

  it("normalizes non-Error consumeTrackingStream failures before reporting onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new TrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_tracking_string_error",
        });
        res.end(JSON.stringify({ id: "run_tracking_string_error" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      return new ReadableStream({
        start(controller) {
          controller.error("tracking string failure");
        },
      });
    };

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-tracking-string-error",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    await expect(readChunks(stream)).rejects.toBe("tracking string failure");

    await waitForCondition(function () {
      return errors.length === 1;
    });

    expect(errors[0]).toMatchObject({
      phase: "consumeTrackingStream",
      chatId: "chat-tracking-string-error",
      runId: "run_tracking_string_error",
    });
    expect(errors[0]?.error.message).toBe("tracking string failure");
    expect(runStore.get("chat-tracking-string-error")).toBeUndefined();
  });

  it("ignores onError callback failures during consumeTrackingStream errors", async function () {
    const runStore = new TrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_tracking_onerror_failure",
        });
        res.end(JSON.stringify({ id: "run_tracking_onerror_failure" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: async function onError() {
        throw new Error("onError failed");
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      return new ReadableStream({
        start(controller) {
          controller.error(new Error("tracking failed root cause"));
        },
      });
    };

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-tracking-onerror-failure",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    await expect(readChunks(stream)).rejects.toThrowError("tracking failed root cause");

    await waitForCondition(function () {
      return runStore.get("chat-tracking-onerror-failure") === undefined;
    });
  });

  it(
    "preserves consumeTrackingStream root failures when cleanup and onError callbacks both fail",
    async function () {
      const runStore = new FailingCleanupSetRunStore(2);

      const server = await startServer(function (req, res) {
        if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_tracking_cleanup_and_onerror_failure",
          });
          res.end(JSON.stringify({ id: "run_tracking_cleanup_and_onerror_failure" }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      const transport = new TriggerChatTransport({
        task: "chat-task",
        stream: "chat-stream",
        accessToken: "pk_trigger",
        baseURL: server.url,
        runStore,
        onError: async function onError() {
          throw new Error("onError failed");
        },
      });

      (transport as any).fetchRunStream = async function fetchRunStream() {
        return new ReadableStream({
          start(controller) {
            controller.error(new Error("tracking failed root cause"));
          },
        });
      };

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-tracking-cleanup-and-onerror-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      await expect(readChunks(stream)).rejects.toThrowError("tracking failed root cause");
    }
  );

  it("preserves consumeTrackingStream failures when cleanup run-store set throws", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupSetRunStore(2);

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_tracking_cleanup_set_failure",
        });
        res.end(JSON.stringify({ id: "run_tracking_cleanup_set_failure" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      return new ReadableStream({
        start(controller) {
          controller.error(new Error("tracking failed root cause"));
        },
      });
    };

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-tracking-cleanup-set-failure",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    await expect(readChunks(stream)).rejects.toThrowError("tracking failed root cause");

    await waitForCondition(function () {
      return errors.length === 1;
    });

    expect(errors[0]).toMatchObject({
      phase: "consumeTrackingStream",
      chatId: "chat-tracking-cleanup-set-failure",
      runId: "run_tracking_cleanup_set_failure",
    });
    expect(errors[0]?.error.message).toBe("tracking failed root cause");
    expect(runStore.deleteCalls).toContain("chat-tracking-cleanup-set-failure");
    expect(runStore.get("chat-tracking-cleanup-set-failure")).toBeUndefined();
  });

  it("preserves consumeTrackingStream failures when cleanup run-store delete throws", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteRunStore(1);

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_tracking_cleanup_delete_failure",
        });
        res.end(JSON.stringify({ id: "run_tracking_cleanup_delete_failure" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      return new ReadableStream({
        start(controller) {
          controller.error(new Error("tracking failed root cause"));
        },
      });
    };

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-tracking-cleanup-delete-failure",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    await expect(readChunks(stream)).rejects.toThrowError("tracking failed root cause");

    await waitForCondition(function () {
      return errors.length === 1;
    });

    expect(errors[0]).toMatchObject({
      phase: "consumeTrackingStream",
      chatId: "chat-tracking-cleanup-delete-failure",
      runId: "run_tracking_cleanup_delete_failure",
    });
    expect(errors[0]?.error.message).toBe("tracking failed root cause");
  });

  it(
    "attempts consumeTracking cleanup set and delete when both cleanup steps throw",
    async function () {
      const errors: TriggerChatTransportError[] = [];
      const runStore = new FailingCleanupSetAndDeleteRunStore();

      const server = await startServer(function (req, res) {
        if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_tracking_cleanup_both_failure",
          });
          res.end(JSON.stringify({ id: "run_tracking_cleanup_both_failure" }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      const transport = new TriggerChatTransport({
        task: "chat-task",
        stream: "chat-stream",
        accessToken: "pk_trigger",
        baseURL: server.url,
        runStore,
        onError: function onError(error) {
          errors.push(error);
        },
      });

      (transport as any).fetchRunStream = async function fetchRunStream() {
        return new ReadableStream({
          start(controller) {
            controller.error(new Error("tracking failed root cause"));
          },
        });
      };

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-tracking-cleanup-both-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      await expect(readChunks(stream)).rejects.toThrowError("tracking failed root cause");

      await waitForCondition(function () {
        return errors.length === 1;
      });

      expect(errors[0]).toMatchObject({
        phase: "consumeTrackingStream",
        chatId: "chat-tracking-cleanup-both-failure",
        runId: "run_tracking_cleanup_both_failure",
      });
      expect(errors[0]?.error.message).toBe("tracking failed root cause");
      expect(runStore.setCalls).toContain("chat-tracking-cleanup-both-failure");
      expect(runStore.deleteCalls).toContain("chat-tracking-cleanup-both-failure");
    }
  );

  it(
    "preserves consumeTracking root failures when cleanup set/delete and onError callbacks all fail",
    async function () {
      const runStore = new FailingCleanupSetAndDeleteRunStore();

      const server = await startServer(function (req, res) {
        if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_tracking_cleanup_all_failure",
          });
          res.end(JSON.stringify({ id: "run_tracking_cleanup_all_failure" }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      const transport = new TriggerChatTransport({
        task: "chat-task",
        stream: "chat-stream",
        accessToken: "pk_trigger",
        baseURL: server.url,
        runStore,
        onError: async function onError() {
          throw new Error("onError failed");
        },
      });

      (transport as any).fetchRunStream = async function fetchRunStream() {
        return new ReadableStream({
          start(controller) {
            controller.error(new Error("tracking failed root cause"));
          },
        });
      };

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-tracking-cleanup-all-failure",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      await expect(readChunks(stream)).rejects.toThrowError("tracking failed root cause");
      expect(runStore.setCalls).toContain("chat-tracking-cleanup-all-failure");
      expect(runStore.deleteCalls).toContain("chat-tracking-cleanup-all-failure");
    }
  );

  it("reports reconnect failures through onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new InMemoryTriggerChatRunStore();
    runStore.set({
      chatId: "chat-reconnect-error",
      runId: "run_reconnect_error",
      publicAccessToken: "pk_reconnect_error",
      streamKey: "chat-stream",
      lastEventId: "100-0",
      isActive: true,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("reconnect root cause");
    };

    const stream = await transport.reconnectToStream({
      chatId: "chat-reconnect-error",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-reconnect-error",
      runId: "run_reconnect_error",
    });
    expect(errors[0]?.error.message).toBe("reconnect root cause");
    expect(runStore.get("chat-reconnect-error")).toBeUndefined();
  });

  it("preserves reconnect failures when cleanup run-store set throws", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupSetRunStore(2);
    runStore.set({
      chatId: "chat-reconnect-cleanup-set-failure",
      runId: "run_reconnect_cleanup_set_failure",
      publicAccessToken: "pk_reconnect_cleanup_set_failure",
      streamKey: "chat-stream",
      lastEventId: "100-0",
      isActive: true,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("reconnect root cause");
    };

    const stream = await transport.reconnectToStream({
      chatId: "chat-reconnect-cleanup-set-failure",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-reconnect-cleanup-set-failure",
      runId: "run_reconnect_cleanup_set_failure",
    });
    expect(errors[0]?.error.message).toBe("reconnect root cause");
    expect(runStore.deleteCalls).toContain("chat-reconnect-cleanup-set-failure");
    expect(runStore.get("chat-reconnect-cleanup-set-failure")).toBeUndefined();
  });

  it("preserves reconnect failures when cleanup run-store delete throws", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteRunStore(1);
    let fetchCalls = 0;
    runStore.set({
      chatId: "chat-reconnect-cleanup-delete-failure",
      runId: "run_reconnect_cleanup_delete_failure",
      publicAccessToken: "pk_reconnect_cleanup_delete_failure",
      streamKey: "chat-stream",
      lastEventId: "100-0",
      isActive: true,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      fetchCalls += 1;
      throw new Error("reconnect root cause");
    };

    const stream = await transport.reconnectToStream({
      chatId: "chat-reconnect-cleanup-delete-failure",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-reconnect-cleanup-delete-failure",
      runId: "run_reconnect_cleanup_delete_failure",
    });
    expect(errors[0]?.error.message).toBe("reconnect root cause");
    expect(fetchCalls).toBe(1);
    expect(runStore.get("chat-reconnect-cleanup-delete-failure")).toMatchObject({
      isActive: false,
      lastEventId: "100-0",
    });

    const secondReconnect = await transport.reconnectToStream({
      chatId: "chat-reconnect-cleanup-delete-failure",
    });

    expect(secondReconnect).toBeNull();
    expect(fetchCalls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(runStore.get("chat-reconnect-cleanup-delete-failure")).toBeUndefined();
  });

  it("returns null when active reconnect cleanup delete fails without onError callback", async function () {
    const runStore = new FailingCleanupDeleteRunStore(1);
    let fetchCalls = 0;
    runStore.set({
      chatId: "chat-reconnect-cleanup-delete-no-onerror",
      runId: "run_reconnect_cleanup_delete_no_onerror",
      publicAccessToken: "pk_reconnect_cleanup_delete_no_onerror",
      streamKey: "chat-stream",
      lastEventId: "100-0",
      isActive: true,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      fetchCalls += 1;
      throw new Error("reconnect root cause");
    };

    const firstReconnect = await transport.reconnectToStream({
      chatId: "chat-reconnect-cleanup-delete-no-onerror",
    });

    expect(firstReconnect).toBeNull();
    expect(fetchCalls).toBe(1);
    expect(runStore.get("chat-reconnect-cleanup-delete-no-onerror")).toMatchObject({
      isActive: false,
      lastEventId: "100-0",
    });

    const secondReconnect = await transport.reconnectToStream({
      chatId: "chat-reconnect-cleanup-delete-no-onerror",
    });

    expect(secondReconnect).toBeNull();
    expect(fetchCalls).toBe(1);
    expect(runStore.get("chat-reconnect-cleanup-delete-no-onerror")).toBeUndefined();
  });

  it("preserves reconnect root failure when cleanup delete throws a non-Error value", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteValueRunStore("cleanup delete string failure");
    let fetchCalls = 0;
    runStore.set({
      chatId: "chat-reconnect-cleanup-delete-string-failure",
      runId: "run_reconnect_cleanup_delete_string_failure",
      publicAccessToken: "pk_reconnect_cleanup_delete_string_failure",
      streamKey: "chat-stream",
      lastEventId: "100-0",
      isActive: true,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      fetchCalls += 1;
      throw new Error("reconnect root cause");
    };

    const firstReconnect = await transport.reconnectToStream({
      chatId: "chat-reconnect-cleanup-delete-string-failure",
    });

    expect(firstReconnect).toBeNull();
    expect(fetchCalls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-reconnect-cleanup-delete-string-failure",
      runId: "run_reconnect_cleanup_delete_string_failure",
    });
    expect(errors[0]?.error.message).toBe("reconnect root cause");
    expect(runStore.get("chat-reconnect-cleanup-delete-string-failure")).toMatchObject({
      isActive: false,
      lastEventId: "100-0",
    });

    const secondReconnect = await transport.reconnectToStream({
      chatId: "chat-reconnect-cleanup-delete-string-failure",
    });

    expect(secondReconnect).toBeNull();
    expect(fetchCalls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(runStore.get("chat-reconnect-cleanup-delete-string-failure")).toBeUndefined();
  });

  it("attempts both reconnect cleanup steps when set and delete both throw", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupSetAndDeleteRunStore();
    runStore.set({
      chatId: "chat-reconnect-cleanup-both-failure",
      runId: "run_reconnect_cleanup_both_failure",
      publicAccessToken: "pk_reconnect_cleanup_both_failure",
      streamKey: "chat-stream",
      lastEventId: "100-0",
      isActive: true,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("reconnect root cause");
    };

    const stream = await transport.reconnectToStream({
      chatId: "chat-reconnect-cleanup-both-failure",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-reconnect-cleanup-both-failure",
      runId: "run_reconnect_cleanup_both_failure",
    });
    expect(errors[0]?.error.message).toBe("reconnect root cause");
    expect(runStore.setCalls).toContain("chat-reconnect-cleanup-both-failure");
    expect(runStore.deleteCalls).toContain("chat-reconnect-cleanup-both-failure");
  });

  it(
    "preserves reconnect root failures when cleanup and onError callbacks both fail",
    async function () {
      const runStore = new FailingCleanupDeleteRunStore(1);
      runStore.set({
        chatId: "chat-reconnect-cleanup-and-onerror-failure",
        runId: "run_reconnect_cleanup_and_onerror_failure",
        publicAccessToken: "pk_reconnect_cleanup_and_onerror_failure",
        streamKey: "chat-stream",
        lastEventId: "100-0",
        isActive: true,
      });

      const transport = new TriggerChatTransport({
        task: "chat-task",
        stream: "chat-stream",
        accessToken: "pk_trigger",
        runStore,
        onError: async function onError() {
          throw new Error("onError failed");
        },
      });

      (transport as any).fetchRunStream = async function fetchRunStream() {
        throw new Error("reconnect root cause");
      };

      const stream = await transport.reconnectToStream({
        chatId: "chat-reconnect-cleanup-and-onerror-failure",
      });

      expect(stream).toBeNull();
    }
  );

  it(
    "preserves reconnect root failures when cleanup set/delete and onError callbacks all fail",
    async function () {
      const runStore = new FailingCleanupSetAndDeleteRunStore();
      runStore.set({
        chatId: "chat-reconnect-cleanup-all-failure",
        runId: "run_reconnect_cleanup_all_failure",
        publicAccessToken: "pk_reconnect_cleanup_all_failure",
        streamKey: "chat-stream",
        lastEventId: "100-0",
        isActive: true,
      });

      const transport = new TriggerChatTransport({
        task: "chat-task",
        stream: "chat-stream",
        accessToken: "pk_trigger",
        runStore,
        onError: async function onError() {
          throw new Error("onError failed");
        },
      });

      (transport as any).fetchRunStream = async function fetchRunStream() {
        throw new Error("reconnect root cause");
      };

      const stream = await transport.reconnectToStream({
        chatId: "chat-reconnect-cleanup-all-failure",
      });

      expect(stream).toBeNull();
      expect(runStore.setCalls).toContain("chat-reconnect-cleanup-all-failure");
      expect(runStore.deleteCalls).toContain("chat-reconnect-cleanup-all-failure");
    }
  );

  it("normalizes non-Error reconnect failures before reporting onError", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new InMemoryTriggerChatRunStore();
    runStore.set({
      chatId: "chat-reconnect-string-failure",
      runId: "run_reconnect_string_failure",
      publicAccessToken: "pk_reconnect_string_failure",
      streamKey: "chat-stream",
      lastEventId: "100-0",
      isActive: true,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw "reconnect string failure";
    };

    const stream = await transport.reconnectToStream({
      chatId: "chat-reconnect-string-failure",
    });

    expect(stream).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-reconnect-string-failure",
      runId: "run_reconnect_string_failure",
    });
    expect(errors[0]?.error.message).toBe("reconnect string failure");
    expect(runStore.get("chat-reconnect-string-failure")).toBeUndefined();
  });

  it("ignores onError callback failures during reconnect error reporting", async function () {
    const runStore = new InMemoryTriggerChatRunStore();
    runStore.set({
      chatId: "chat-reconnect-onerror-failure",
      runId: "run_reconnect_onerror_failure",
      publicAccessToken: "pk_reconnect_onerror_failure",
      streamKey: "chat-stream",
      lastEventId: "100-0",
      isActive: true,
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      runStore,
      onError: async function onError() {
        throw new Error("onError failed");
      },
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("reconnect root cause");
    };

    const stream = await transport.reconnectToStream({
      chatId: "chat-reconnect-onerror-failure",
    });

    expect(stream).toBeNull();
    expect(runStore.get("chat-reconnect-onerror-failure")).toBeUndefined();
  });

  it("cleans run store state when stream completes", async function () {
    const trackedRunStore = new TrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_cleanup",
        });
        res.end(JSON.stringify({ id: "run_cleanup" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_cleanup/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "cleanup_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "cleanup_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore: trackedRunStore,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-cleanup",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);

    await waitForCondition(function () {
      return trackedRunStore.deleteCalls.includes("chat-cleanup");
    });

    expect(trackedRunStore.setSnapshots).toHaveLength(4);
    expect(trackedRunStore.setSnapshots[0]).toMatchObject({
      chatId: "chat-cleanup",
      runId: "run_cleanup",
      isActive: true,
      lastEventId: undefined,
    });
    expect(trackedRunStore.setSnapshots[1]).toMatchObject({
      chatId: "chat-cleanup",
      runId: "run_cleanup",
      isActive: true,
      lastEventId: "1-0",
    });
    expect(trackedRunStore.setSnapshots[2]).toMatchObject({
      chatId: "chat-cleanup",
      runId: "run_cleanup",
      isActive: true,
      lastEventId: "2-0",
    });
    expect(trackedRunStore.setSnapshots[3]).toMatchObject({
      chatId: "chat-cleanup",
      runId: "run_cleanup",
      isActive: false,
      lastEventId: "2-0",
    });
    expect(trackedRunStore.get("chat-cleanup")).toBeUndefined();
  });

  it("keeps completed streams successful when cleanup delete fails", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupDeleteRunStore(1);

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_cleanup_delete_failure",
        });
        res.end(JSON.stringify({ id: "run_cleanup_delete_failure" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_cleanup_delete_failure/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "cleanup_delete_failure_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "cleanup_delete_failure_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-cleanup-delete-failure",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(errors).toHaveLength(0);

    await waitForCondition(function () {
      const state = runStore.get("chat-cleanup-delete-failure");
      return Boolean(state && state.isActive === false);
    });
  });

  it("keeps completed streams successful when cleanup set fails", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupSetRunStore(4);

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_cleanup_set_failure",
        });
        res.end(JSON.stringify({ id: "run_cleanup_set_failure" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_cleanup_set_failure/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "cleanup_set_failure_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "cleanup_set_failure_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-cleanup-set-failure",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(errors).toHaveLength(0);

    await waitForCondition(function () {
      return runStore.get("chat-cleanup-set-failure") === undefined;
    });
    expect(runStore.deleteCalls).toContain("chat-cleanup-set-failure");
  });

  it("keeps completed streams successful when cleanup set and delete both fail", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupSetAndDeleteRunStore(4);

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_cleanup_set_delete_failure",
        });
        res.end(JSON.stringify({ id: "run_cleanup_set_delete_failure" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_cleanup_set_delete_failure/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "cleanup_set_delete_failure_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "cleanup_set_delete_failure_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-cleanup-set-delete-failure",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(errors).toHaveLength(0);

    await waitForCondition(function () {
      const state = runStore.get("chat-cleanup-set-delete-failure");
      return Boolean(state && state.isActive === true && state.lastEventId === "2-0");
    });
    expect(runStore.setCalls).toContain("chat-cleanup-set-delete-failure");
    expect(runStore.deleteCalls).toContain("chat-cleanup-set-delete-failure");
  });

  it("returns null on reconnect after completion when cleanup set and delete both fail", async function () {
    const errors: TriggerChatTransportError[] = [];
    const runStore = new FailingCleanupSetAndDeleteRunStore(4);

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_done_cleanup_both_failure",
        });
        res.end(JSON.stringify({ id: "run_done_cleanup_both_failure" }));
        return;
      }

      if (
        req.method === "GET" &&
        req.url === "/realtime/v1/streams/run_done_cleanup_both_failure/chat-stream"
      ) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "done_cleanup_both_failure_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "done_cleanup_both_failure_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-done-cleanup-both-failure",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);

    await waitForCondition(function () {
      return runStore.deleteCalls.includes("chat-done-cleanup-both-failure");
    });

    (transport as any).fetchRunStream = async function fetchRunStream() {
      throw new Error("reconnect root cause");
    };

    const reconnect = await transport.reconnectToStream({
      chatId: "chat-done-cleanup-both-failure",
    });

    expect(reconnect).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      phase: "reconnect",
      chatId: "chat-done-cleanup-both-failure",
      runId: "run_done_cleanup_both_failure",
    });
    expect(errors[0]?.error.message).toBe("reconnect root cause");
  });

  it("returns null from reconnect after stream completion cleanup", async function () {
    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_done",
        });
        res.end(JSON.stringify({ id: "run_done" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_done/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "done_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "done_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-done",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);

    await waitForCondition(async function () {
      const reconnect = await transport.reconnectToStream({
        chatId: "chat-done",
      });

      return reconnect === null;
    });
  });

  it("supports async run store implementations", async function () {
    const runStore = new AsyncTrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_async",
        });
        res.end(JSON.stringify({ id: "run_async" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_async/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "async_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "async_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-async",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);

    await waitForCondition(function () {
      return runStore.deleteCalls.includes("chat-async");
    });

    expect(runStore.setCalls).toContain("chat-async");
    expect(runStore.getCalls).toContain("chat-async");
    expect(runStore.getCalls.length).toBeGreaterThan(0);
    expect(runStore.setCalls.length).toBeGreaterThan(0);
    expect(runStore.deleteCalls.length).toBeGreaterThan(0);
    await expect(runStore.get("chat-async")).resolves.toBeUndefined();
  });

  it("reconnects active streams using tracked lastEventId", async function () {
    let reconnectLastEventId: string | undefined;
    let firstStreamResponse: ServerResponse<IncomingMessage> | undefined;
    let firstStreamChunkSent = false;
    const errors: TriggerChatTransportError[] = [];
    const runStore = new InMemoryTriggerChatRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_456",
        });
        res.end(JSON.stringify({ id: "run_456" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_456/chat-stream") {
        const lastEventId = req.headers["last-event-id"];
        const normalizedLastEventId = Array.isArray(lastEventId)
          ? lastEventId[0]
          : lastEventId;

        if (typeof normalizedLastEventId === "string") {
          reconnectLastEventId = normalizedLastEventId;
          res.writeHead(200, {
            "content-type": "text/event-stream",
          });
          writeSSE(
            res,
            "2-0",
            JSON.stringify({ type: "text-delta", id: "msg_2", delta: "world" })
          );
          writeSSE(
            res,
            "3-0",
            JSON.stringify({ type: "text-end", id: "msg_2" })
          );
          res.end();
          return;
        }

        firstStreamResponse = res;
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "msg_2" })
        );
        firstStreamChunkSent = true;
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
      onError: function onError(error) {
        errors.push(error);
      },
    });

    try {
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-2",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      await waitForCondition(function () {
        if (!firstStreamChunkSent) {
          return false;
        }

        const state = runStore.get("chat-2");
        return Boolean(state && state.lastEventId === "1-0");
      });

      const reconnectStream = await transport.reconnectToStream({
        chatId: "chat-2",
      });

      expect(reconnectStream).not.toBeNull();

      const reconnectChunks = await readChunks(reconnectStream!);
      expect(reconnectLastEventId).toBe("1-0");
      expect(reconnectChunks).toHaveLength(2);
      expect(reconnectChunks[0]).toMatchObject({
        chunk: { type: "text-delta", id: "msg_2", delta: "world" },
      });
      expect(reconnectChunks[1]).toMatchObject({
        chunk: { type: "text-end", id: "msg_2" },
      });
      expect(errors).toHaveLength(0);
    } finally {
      if (firstStreamResponse) {
        firstStreamResponse.end();
      }
    }
  });
});

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => void
) {
  const nodeServer = createServer(handler);

  await new Promise<void>(function (resolve) {
    nodeServer.listen(0, "127.0.0.1", function () {
      resolve();
    });
  });

  const address = nodeServer.address() as AddressInfo;
  const server: TestServer = {
    url: `http://127.0.0.1:${address.port}`,
    close: function () {
      if (typeof nodeServer.closeAllConnections === "function") {
        nodeServer.closeAllConnections();
      }

      return new Promise<void>(function (resolve, reject) {
        nodeServer.close(function (error) {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };

  activeServers.push(server);

  return server;
}

function writeSSE(res: ServerResponse<IncomingMessage>, id: string, data: string) {
  res.write(`id: ${id}\n`);
  res.write(`data: ${data}\n\n`);
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: string[] = [];
  for await (const chunk of req) {
    chunks.push(chunk.toString());
  }
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

async function readChunks(stream: ReadableStream<UIMessageChunk>) {
  const parts: Array<{ type: string; id?: string; chunk: UIMessageChunk }> = [];
  for await (const chunk of stream) {
    const part: { type: string; id?: string; chunk: UIMessageChunk } = {
      type: chunk.type,
      chunk,
    };

    if ("id" in chunk && typeof chunk.id === "string") {
      part.id = chunk.id;
    }

    parts.push(part);
  }

  return parts;
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutInMs = 5000
) {
  const start = Date.now();

  while (Date.now() - start < timeoutInMs) {
    if (await condition()) {
      return;
    }

    await new Promise<void>(function (resolve) {
      setTimeout(resolve, 25);
    });
  }

  throw new Error(`Condition was not met within ${timeoutInMs}ms`);
}

class TrackedRunStore extends InMemoryTriggerChatRunStore {
  public readonly setSnapshots: TriggerChatRunState[] = [];
  public readonly deleteCalls: string[] = [];

  public set(state: TriggerChatRunState): void {
    this.setSnapshots.push({
      ...state,
    });
    super.set(state);
  }

  public delete(chatId: string): void {
    this.deleteCalls.push(chatId);
    super.delete(chatId);
  }
}

class FailingCleanupSetRunStore extends InMemoryTriggerChatRunStore {
  private setCalls = 0;
  public readonly deleteCalls: string[] = [];

  constructor(private readonly failOnSetCall: number) {
    super();
  }

  public set(state: TriggerChatRunState): void {
    this.setCalls += 1;
    if (this.setCalls === this.failOnSetCall) {
      throw new Error("cleanup set failed");
    }

    super.set(state);
  }

  public delete(chatId: string): void {
    this.deleteCalls.push(chatId);
    super.delete(chatId);
  }
}

class FailingCleanupDeleteRunStore extends InMemoryTriggerChatRunStore {
  private deleteCalls = 0;

  constructor(private readonly failOnDeleteCall: number) {
    super();
  }

  public delete(chatId: string): void {
    this.deleteCalls += 1;
    if (this.deleteCalls === this.failOnDeleteCall) {
      throw new Error("cleanup delete failed");
    }

    super.delete(chatId);
  }
}

class FailingCleanupDeleteValueRunStore extends InMemoryTriggerChatRunStore {
  public deleteCallCount = 0;

  constructor(private readonly thrownValue: unknown) {
    super();
  }

  public delete(chatId: string): void {
    this.deleteCallCount += 1;
    if (this.deleteCallCount === 1) {
      throw this.thrownValue;
    }

    super.delete(chatId);
  }
}

class AlwaysFailCleanupDeleteRunStore extends InMemoryTriggerChatRunStore {
  public deleteCallCount = 0;

  public delete(_chatId: string): void {
    this.deleteCallCount += 1;
    throw new Error("cleanup delete always fails");
  }
}

class FailingCleanupSetAndDeleteRunStore extends InMemoryTriggerChatRunStore {
  private setCallCount = 0;
  public readonly setCalls: string[] = [];
  public readonly deleteCalls: string[] = [];

  constructor(private readonly failOnSetCall: number = 2) {
    super();
  }

  public set(state: TriggerChatRunState): void {
    this.setCallCount += 1;
    this.setCalls.push(state.chatId);
    if (this.setCallCount === this.failOnSetCall) {
      throw new Error("cleanup set failed");
    }

    super.set(state);
  }

  public delete(chatId: string): void {
    this.deleteCalls.push(chatId);
    throw new Error("cleanup delete failed");
  }
}

class AsyncTrackedRunStore implements TriggerChatRunStore {
  private readonly runs = new Map<string, TriggerChatRunState>();
  public readonly getCalls: string[] = [];
  public readonly setCalls: string[] = [];
  public readonly deleteCalls: string[] = [];

  public async get(chatId: string): Promise<TriggerChatRunState | undefined> {
    this.getCalls.push(chatId);
    await sleep(1);
    return this.runs.get(chatId);
  }

  public async set(state: TriggerChatRunState): Promise<void> {
    this.setCalls.push(state.chatId);
    await sleep(1);
    this.runs.set(state.chatId, state);
  }

  public async delete(chatId: string): Promise<void> {
    this.deleteCalls.push(chatId);
    await sleep(1);
    this.runs.delete(chatId);
  }
}

async function sleep(timeoutInMs: number) {
  await new Promise<void>(function (resolve) {
    setTimeout(resolve, timeoutInMs);
  });
}
