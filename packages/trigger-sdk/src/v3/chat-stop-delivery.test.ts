import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TriggerChatTransport,
  type ChatTransportEvent,
  type TriggerChatTransportOptions,
} from "./chat.js";

type InputRequest = {
  kind: "message" | "stop";
  partId: string | string[] | undefined;
  authorization: string | undefined;
  response: ServerResponse;
  seq: number;
};

type SendKind = "message" | "action";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Stop delivery outcomes", () => {
  let server: Server;
  let baseURL: string;
  let transport: TriggerChatTransport;
  let inputs: InputRequest[];
  let outputs: ServerResponse[];
  let events: ChatTransportEvent[];
  let respond: (input: InputRequest) => void;
  let inputSeq: number;

  function createTransport(options: Partial<TriggerChatTransportOptions> = {}) {
    return new TriggerChatTransport({
      task: "test-chat",
      baseURL,
      accessToken: () => "test-token",
      sessions: { chat: { publicAccessToken: "test-token", lastEventId: "1" } },
      onEvent: (event) => events.push(event),
      ...options,
    });
  }

  function appendResponse(input: InputRequest, status = 200) {
    input.response
      .writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify({ seq: input.seq }));
  }

  beforeEach(async () => {
    inputs = [];
    outputs = [];
    events = [];
    inputSeq = 10;
    respond = (input) => appendResponse(input);
    server = createServer(async (request, response) => {
      if (request.method === "POST") {
        let body = "";
        for await (const data of request) body += data;
        const parsed: unknown = JSON.parse(body);
        const kind =
          typeof parsed === "object" &&
          parsed !== null &&
          "kind" in parsed &&
          parsed.kind === "stop"
            ? "stop"
            : "message";
        const input: InputRequest = {
          kind,
          partId: request.headers["x-part-id"],
          authorization: request.headers.authorization,
          response,
          seq: inputSeq++,
        };
        inputs.push(input);
        respond(input);
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Stream-Version": "v2",
      });
      response.flushHeaders();
      outputs.push(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    baseURL = `http://127.0.0.1:${address.port}`;
    transport = createTransport();
  });

  afterEach(async () => {
    transport.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function send(kind: SendKind, abortSignal?: AbortSignal) {
    return kind === "action"
      ? transport.sendAction("chat", { type: "undo" }, { abortSignal })
      : transport.sendMessages({
          chatId: "chat",
          trigger: "submit-message",
          messageId: "user",
          messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "Continue" }] }],
          abortSignal,
        });
  }

  function stop(throwOnError: boolean) {
    return throwOnError
      ? transport.stopGeneration("chat", { throwOnError: true })
      : transport.stopGeneration("chat");
  }

  function sendFailures() {
    return events.filter((event) => event.type === "message-send-failed");
  }

  it.each([false, true])(
    "returns true after accepted Stop delivery (throwOnError: %s)",
    async (throwOnError) => {
      await expect(stop(throwOnError)).resolves.toBe(true);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.kind).toBe("stop");
      expect(sendFailures()).toHaveLength(0);
    }
  );

  it.each([false, true])(
    "returns false without local state (throwOnError: %s)",
    async (throwOnError) => {
      transport.dispose();
      transport = createTransport({ sessions: {} });
      await expect(stop(throwOnError)).resolves.toBe(false);
      expect(inputs).toHaveLength(0);
      expect(sendFailures()).toHaveLength(0);
    }
  );

  it.each(["HTTP", "network"] as const)(
    "keeps the default false result after a %s failure",
    async (failure) => {
      respond = (input) => {
        if (failure === "network") input.response.destroy();
        else appendResponse(input, 429);
      };
      await expect(transport.stopGeneration("chat")).resolves.toBe(false);
      expect(inputs).toHaveLength(1);
      expect(sendFailures()).toHaveLength(1);
      expect(sendFailures()[0]).toMatchObject({ source: "stop" });
    }
  );

  it.each(["HTTP", "network"] as const)(
    "rejects the original %s delivery error with throwOnError",
    async (failure) => {
      respond = (input) => {
        if (failure === "network") input.response.destroy();
        else appendResponse(input, 429);
      };
      const error: unknown = await stop(true).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      if (failure === "HTTP") expect(error).toMatchObject({ name: "TriggerApiError", status: 429 });
      else expect(error).toBeInstanceOf(TypeError);
      const failed = sendFailures()[0];
      if (failed?.type !== "message-send-failed")
        throw new Error("Expected a delivery failure event");
      expect(failed.source).toBe("stop");
      expect(failed.error).toBe(error);
      expect(inputs).toHaveLength(1);
    }
  );

  it.each([false, true])(
    "renews a Stop token with the same input ID (throwOnError: %s)",
    async (throwOnError) => {
      let renewals = 0;
      transport.dispose();
      transport = createTransport({
        accessToken: () => {
          renewals++;
          return "fresh-token";
        },
      });
      respond = (input) =>
        appendResponse(input, input.authorization === "Bearer fresh-token" ? 200 : 401);
      await expect(stop(throwOnError)).resolves.toBe(true);
      expect(renewals).toBe(1);
      expect(inputs).toHaveLength(2);
      expect(inputs[0]?.partId).toBeTruthy();
      expect(inputs[1]?.partId).toBe(inputs[0]?.partId);
      expect(inputs.map((input) => input.authorization)).toEqual([
        "Bearer test-token",
        "Bearer fresh-token",
      ]);
      expect(sendFailures()).toHaveLength(0);
    }
  );

  it.each([null, undefined])("preserves a token renewal rejection of %s", async (rejection) => {
    transport.dispose();
    transport = createTransport({ accessToken: () => Promise.reject(rejection) });
    respond = (input) => appendResponse(input, 401);
    await expect(stop(true)).rejects.toBe(rejection);
    expect(inputs).toHaveLength(1);
    expect(sendFailures()).toHaveLength(1);
    expect(sendFailures()[0]).toMatchObject({
      source: "stop",
      error: { message: String(rejection) },
    });
  });

  it.each([false, true])("stops after a repeated 403 (throwOnError: %s)", async (throwOnError) => {
    let renewals = 0;
    transport.dispose();
    transport = createTransport({
      accessToken: () => {
        renewals++;
        return "fresh-token";
      },
    });
    respond = (input) => appendResponse(input, 403);
    if (throwOnError)
      await expect(stop(true)).rejects.toMatchObject({ name: "TriggerApiError", status: 403 });
    else await expect(stop(false)).resolves.toBe(false);
    expect(renewals).toBe(1);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.partId).toBe(inputs[0]?.partId);
    expect(sendFailures()).toHaveLength(1);
    expect(sendFailures()[0]).toMatchObject({ source: "stop", status: 403 });
  });

  describe.each([false, true])("missing Stop session (throwOnError: %s)", (throwOnError) => {
    it.each([false, true])(
      "preserves the boundary without recreation (renew token: %s)",
      async (renewToken) => {
        let starts = 0;
        let renewals = 0;
        transport.dispose();
        transport = createTransport({
          accessToken: () => {
            renewals++;
            return "fresh-token";
          },
          startSession: async () => {
            starts++;
            return { publicAccessToken: "replacement-token" };
          },
        });
        await send("message");
        await vi.waitFor(() => expect(outputs).toHaveLength(1));
        respond = (input) =>
          appendResponse(
            input,
            renewToken && input.authorization === "Bearer test-token" ? 401 : 404
          );
        if (throwOnError)
          await expect(stop(true)).rejects.toMatchObject({ name: "TriggerApiError", status: 404 });
        else await expect(stop(false)).resolves.toBe(false);
        expect(starts).toBe(0);
        expect(renewals).toBe(renewToken ? 1 : 0);
        expect(inputs.filter((input) => input.kind === "stop")).toHaveLength(renewToken ? 2 : 1);
        expect(transport.getSession("chat")).toMatchObject({
          lastEventId: "1",
          activeInputSeq: 10,
          supersededInputSeq: 10,
          skipToTurnComplete: true,
          isStreaming: false,
        });
        await vi.waitFor(() => expect(outputs[0]?.destroyed).toBe(true));
      }
    );
  });

  it.each(["success", "failure"] as const)(
    "sends one explicit Stop before abort with a delayed %s",
    async (outcome) => {
      const abort = new AbortController();
      const reader = (await send("message", abort.signal)).getReader();
      await vi.waitFor(() => expect(outputs).toHaveLength(1));
      respond = () => {};
      const stopped = stop(true);
      const result = Promise.allSettled([stopped]);
      abort.abort();
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      await vi.waitFor(() =>
        expect(inputs.filter((input) => input.kind === "stop")).toHaveLength(1)
      );
      expect(transport.getSession("chat")).toMatchObject({
        skipToTurnComplete: true,
        supersededInputSeq: 10,
        isStreaming: false,
      });
      const pendingStop = inputs.find((input) => input.kind === "stop");
      if (!pendingStop) throw new Error("Expected a Stop request");
      appendResponse(pendingStop, outcome === "success" ? 200 : 429);
      if (outcome === "success") {
        await expect(result).resolves.toEqual([{ status: "fulfilled", value: true }]);
      } else {
        await expect(result).resolves.toMatchObject([
          { status: "rejected", reason: { status: 429 } },
        ]);
        expect(transport.getSession("chat")).toMatchObject({
          supersededInputSeq: 10,
          skipToTurnComplete: true,
        });
      }
      expect(inputs.filter((input) => input.kind === "stop")).toHaveLength(1);
    }
  );

  describe.each(["message", "action"] as const)("%s cancellation", (kind) => {
    it("does not hold a tab claim during cancelled session creation", async () => {
      const token = deferred<string>();
      let starts = 0;
      transport.dispose();
      transport = createTransport({
        sessions: {},
        multiTab: true,
        startSession: async () => {
          starts++;
          return { publicAccessToken: await token.promise };
        },
      });
      const abort = new AbortController();
      const sending = send(kind, abort.signal);
      expect(starts).toBe(1);
      expect(transport.hasClaim("chat")).toBe(false);
      abort.abort();
      token.resolve("test-token");
      await expect(sending).rejects.toBe(abort.signal.reason);
      expect(transport.hasClaim("chat")).toBe(false);
      expect(inputs).toHaveLength(0);
    });

    it("releases its tab claim after cancellation during token renewal", async () => {
      const token = deferred<string>();
      let renewals = 0;
      transport.dispose();
      transport = createTransport({
        multiTab: true,
        accessToken: () => {
          renewals++;
          return token.promise;
        },
      });
      respond = (input) => appendResponse(input, 401);
      const abort = new AbortController();
      const sending = send(kind, abort.signal);
      await vi.waitFor(() => expect(renewals).toBe(1));
      expect(transport.hasClaim("chat")).toBe(true);
      abort.abort();
      token.resolve("fresh-token");
      await expect(sending).rejects.toBe(abort.signal.reason);
      expect(transport.hasClaim("chat")).toBe(false);
      expect(inputs).toHaveLength(1);
      expect(sendFailures()).toHaveLength(0);
    });

    it.each(["pending", "active"] as const)(
      "retains a %s successor tab claim after an older cancellation",
      async (successor) => {
        const token = deferred<string>();
        let renewals = 0;
        transport.dispose();
        transport = createTransport({
          multiTab: true,
          accessToken: () => {
            renewals++;
            return token.promise;
          },
        });
        respond = (input) => {
          if (inputs.length === 1) appendResponse(input, 401);
        };
        const abort = new AbortController();
        const first = send(kind, abort.signal);
        await vi.waitFor(() => expect(renewals).toBe(1));
        abort.abort();
        const second = send(kind);
        await vi.waitFor(() => expect(inputs).toHaveLength(2));
        expect(transport.hasClaim("chat")).toBe(true);
        const pending = inputs[1];
        if (!pending) throw new Error("Expected the successor input");
        if (successor === "active") {
          appendResponse(pending);
          await second;
          await vi.waitFor(() => expect(outputs).toHaveLength(1));
        }
        token.resolve("fresh-token");
        await expect(first).rejects.toBe(abort.signal.reason);
        expect(transport.hasClaim("chat")).toBe(true);
        expect(inputs).toHaveLength(2);
        if (successor === "pending") appendResponse(pending);
        await second;
        expect(sendFailures()).toHaveLength(0);
      }
    );

    it("rejects an already-aborted send before session creation", async () => {
      let starts = 0;
      transport.dispose();
      transport = createTransport({
        sessions: {},
        startSession: async () => {
          starts++;
          return { publicAccessToken: "test-token" };
        },
      });
      const abort = new AbortController();
      abort.abort();
      await expect(send(kind, abort.signal)).rejects.toBe(abort.signal.reason);
      expect(starts).toBe(0);
      expect(inputs).toHaveLength(0);
      expect(sendFailures()).toHaveLength(0);
    });

    it.each(["startSession", "accessToken"] as const)(
      "does not append after cancellation during %s",
      async (bootstrap) => {
        const token = deferred<string>();
        let starts = 0;
        let tokenRequests = 0;
        transport.dispose();
        transport = createTransport({
          sessions: {},
          accessToken: () => {
            tokenRequests++;
            return token.promise;
          },
          ...(bootstrap === "startSession"
            ? {
                startSession: async () => {
                  starts++;
                  return { publicAccessToken: await token.promise };
                },
              }
            : {}),
        });
        const abort = new AbortController();
        const sending = send(kind, abort.signal);
        expect(bootstrap === "startSession" ? starts : tokenRequests).toBe(1);
        const stopped = stop(true);
        abort.abort();
        await expect(stopped).resolves.toBe(false);
        token.resolve("test-token");
        await expect(sending).rejects.toBe(abort.signal.reason);
        expect(inputs).toHaveLength(0);
        expect(outputs).toHaveLength(0);
        expect(sendFailures()).toHaveLength(0);
      }
    );

    it("does not retry a cancelled append after token renewal", async () => {
      const token = deferred<string>();
      let renewals = 0;
      transport.dispose();
      transport = createTransport({
        accessToken: () => {
          renewals++;
          return token.promise;
        },
      });
      respond = (input) => appendResponse(input, input.kind === "stop" ? 200 : 401);
      const abort = new AbortController();
      const sending = send(kind, abort.signal);
      await vi.waitFor(() => expect(renewals).toBe(1));
      const stopped = stop(true);
      abort.abort();
      await expect(stopped).resolves.toBe(true);
      token.resolve("fresh-token");
      await expect(sending).rejects.toBe(abort.signal.reason);
      expect(inputs.map((input) => input.kind)).toEqual(["message", "stop"]);
      expect(outputs).toHaveLength(0);
      expect(sendFailures()).toHaveLength(0);
    });

    it.each(["HTTP", "network"] as const)(
      "retains a distinct %s failure after cancellation",
      async (failure) => {
        respond = (input) => {
          if (input.kind === "stop") appendResponse(input);
        };
        const abort = new AbortController();
        const sending = send(kind, abort.signal);
        await vi.waitFor(() => expect(inputs).toHaveLength(1));
        const stopped = stop(true);
        abort.abort();
        await expect(stopped).resolves.toBe(true);
        const pending = inputs[0];
        if (!pending) throw new Error("Expected an input request");
        if (failure === "network") pending.response.destroy();
        else appendResponse(pending, 429);
        const error: unknown = await sending.catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBe(abort.signal.reason);
        const failed = sendFailures()[0];
        if (failed?.type !== "message-send-failed")
          throw new Error("Expected a delivery failure event");
        expect(failed.error).toBe(error);
        expect(failed.source).toBe(kind === "action" ? "action" : "submit-message");
        expect(sendFailures()).toHaveLength(1);
      }
    );
  });
});
