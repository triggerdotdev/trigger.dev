import { describe, expect, it } from "vitest";
import {
  collectInjectedMessageIds,
  injectedMessageIdsOf,
  injectedMessagesOf,
  isInjectionPart,
} from "../src/v3/chat-react.js";

const STEERING = "data-pending-message-injected";
const BACKGROUND = "data-background-injected";

function assistantWith(type: string, data: unknown) {
  return { id: "a1", role: "assistant" as const, parts: [{ type, data }] } as any;
}

describe("pending injection marker helpers", () => {
  it("does not treat a background injection part as an injection point", () => {
    const part = { type: BACKGROUND, data: { messageIds: ["m1"], messages: [{ id: "m1" }] } };

    expect(isInjectionPart(part)).toBe(false);
    expect(injectedMessageIdsOf(part)).toEqual([]);
    expect(injectedMessagesOf(part)).toEqual([]);
    expect(collectInjectedMessageIds([assistantWith(BACKGROUND, part.data)])).toEqual([]);
  });

  it("treats a legacy steering marker as an injection point", () => {
    const data = { messageIds: ["m1"], messages: [{ id: "m1" }] };
    const part = { type: STEERING, data };

    expect(isInjectionPart(part)).toBe(true);
    expect(injectedMessageIdsOf(part)).toEqual(["m1"]);
    expect(injectedMessagesOf(part)).toEqual([{ id: "m1" }]);
    expect(collectInjectedMessageIds([assistantWith(STEERING, data)])).toEqual(["m1"]);
  });

  it("ignores injection parts on non-assistant messages", () => {
    const msg = {
      id: "u1",
      role: "user" as const,
      parts: [{ type: STEERING, data: { messageIds: ["m1"] } }],
    };

    expect(collectInjectedMessageIds([msg as any])).toEqual([]);
  });
});
