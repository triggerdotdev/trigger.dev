import { describe, expect, it } from "vitest";
import {
  serialiseMollifierSnapshot,
  deserialiseMollifierSnapshot,
} from "~/v3/mollifier/mollifierSnapshot.server";
import { prettyPrintPacket } from "@trigger.dev/core/v3";

// Regression test for the Devin "Buffered replay loader passes
// non-string payload to prettyPrintPacket" finding on PR #3757.
//
// Devin's claim is that the snapshot codec double-unwraps the
// payload: `engine.trigger` carries it pre-serialised, then the
// snapshot serialise/deserialise round-trip would JSON.parse it a
// second time, leaving `buffered.payload` as a *parsed* object —
// which `prettyPrintPacket` then mis-handles, producing malformed
// payload display in the Replay dialog.
//
// This test pins the actual contract: the snapshot codec is a single
// JSON.stringify / JSON.parse layer. The payload field stored on the
// engine trigger input is a string (the SDK-serialised payload from
// `payloadPacket.data`). A string round-trips through
// JSON.stringify/JSON.parse unchanged — it does NOT get a second
// unwrap. Therefore `buffered.payload` reaches the replay loader as
// a string, exactly the shape `prettyPrintPacket` expects.
describe("mollifier replay payload shape", () => {
  it("serialise/deserialise preserves the payload as a string", () => {
    // Shape mirrors what `triggerTask.server.ts:#buildEngineTriggerInput`
    // produces — `payload` is `args.payloadPacket.data`, already a JSON
    // string from the SDK's packet serialisation.
    const triggerInput = {
      friendlyId: "run_x",
      taskIdentifier: "hello-world",
      payload: JSON.stringify({ hello: "world", n: 42 }),
      payloadType: "application/json",
      traceId: "trace_x",
      spanId: "span_x",
    };

    const serialised = serialiseMollifierSnapshot(triggerInput);
    const roundTripped = deserialiseMollifierSnapshot(serialised);

    expect(typeof roundTripped.payload).toBe("string");
    expect(roundTripped.payload).toBe(triggerInput.payload);
    expect(roundTripped.payloadType).toBe("application/json");
  });

  it("prettyPrintPacket on the round-tripped payload produces the expected pretty JSON", async () => {
    const original = { hello: "world", nested: { count: 3 } };
    const triggerInput = {
      payload: JSON.stringify(original),
      payloadType: "application/json",
    };

    const roundTripped = deserialiseMollifierSnapshot(serialiseMollifierSnapshot(triggerInput));

    // This is exactly the call the replay loader makes:
    //   prettyPrintPacket(run.payload, run.payloadType)
    // If Devin were right, the payload here would be a parsed object
    // and prettyPrintPacket would either double-encode or skip
    // formatting. In reality it's a string, so we get correct pretty
    // JSON.
    const pretty = await prettyPrintPacket(
      roundTripped.payload,
      roundTripped.payloadType as string
    );

    expect(pretty).toBe(JSON.stringify(original, null, 2));
  });

  it("string payload survives the buffer-codec round-trip even with snapshot fields around it", () => {
    // Replicate the realistic snapshot shape (the engine.trigger input
    // has many sibling fields). Confirms there's no field-shape
    // interaction that would mutate payload.
    const triggerInput = {
      friendlyId: "run_x",
      environment: {
        id: "env",
        type: "DEVELOPMENT",
        project: { id: "p" },
        organization: { id: "o" },
      },
      taskIdentifier: "t",
      payload: '{"a":1}',
      payloadType: "application/json",
      context: { run: { id: "x" } },
      traceContext: { traceparent: "00-...-..." },
      traceId: "abc",
      spanId: "def",
      tags: ["one", "two"],
      depth: 2,
      isTest: false,
    };
    const out = deserialiseMollifierSnapshot(serialiseMollifierSnapshot(triggerInput));
    expect(typeof out.payload).toBe("string");
    expect(out.payload).toBe('{"a":1}');
  });
});
