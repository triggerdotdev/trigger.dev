import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./tool-api-client";
import type { DashboardAgentToolContext } from "./tool-context";
import { buildFeedbackTool } from "./tool-feedback";

const ORIGIN = "https://api.example.com";
const CTX: DashboardAgentToolContext = {
  userActorToken: "uat",
  apiOrigin: ORIGIN,
  chatId: "chat_1",
};

function submit(input: { message: string; toolName?: string }, ctx = CTX) {
  const client = createApiClient(ctx);
  const execute = (buildFeedbackTool({ ctx, client }).submit_feedback as any).execute;
  return execute(input, {} as any) as Promise<any>;
}

function stubFetch(response: Response | Error) {
  const fetch = vi.fn(async (_input: any, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("submit_feedback", () => {
  it("posts the report with the chat it came from, under the delegated token", async () => {
    const fetch = stubFetch(new Response(JSON.stringify({ recorded: true }), { status: 200 }));

    const result = await submit({
      message: "get_queue 500s on a paused queue",
      toolName: "get_queue",
    });

    expect(result).toMatchObject({ recorded: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/v1/dashboard-agent/feedback`);
    expect(init?.method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer uat");
    expect(JSON.parse(String(init?.body))).toEqual({
      chatId: "chat_1",
      message: "get_queue 500s on a paused queue",
      toolName: "get_queue",
    });
  });

  it.each([
    ["an instance that doesn't collect feedback", new Response("{}", { status: 501 })],
    ["a server error", new Response("{}", { status: 500 })],
    ["a transport failure", new Error("socket hang up")],
  ])("carries on quietly on %s, without an error", async (_label, response) => {
    stubFetch(response);

    const result = await submit({ message: "something broke" });

    expect(result.recorded).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("sends nothing without a chat to attribute it to", async () => {
    const fetch = stubFetch(new Response("{}", { status: 200 }));

    const result = await submit({ message: "something broke" }, { ...CTX, chatId: undefined });

    expect(result.error).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
