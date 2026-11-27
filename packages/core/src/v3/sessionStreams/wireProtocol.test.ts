import { describe, expect, it } from "vitest";
import {
  TRIGGER_CONTROL_SUBTYPE,
  TRIGGER_TURN_MARKER_SUBTYPE,
  type TriggerControlSubtype,
} from "./wireProtocol.js";

describe("turn marker subtypes", () => {
  it("do not widen the public TriggerControlSubtype union", () => {
    // Catches: adding a subtype to `TRIGGER_CONTROL_SUBTYPE` in a patch release, which
    // breaks the type check of any caller switching over `TriggerControlSubtype`
    // exhaustively. The `@ts-expect-error` below stops compiling if it widens.
    // @ts-expect-error "turn-start" is not a TriggerControlSubtype
    const widened: TriggerControlSubtype = TRIGGER_TURN_MARKER_SUBTYPE.TURN_START;
    void widened;

    expect(Object.values(TRIGGER_CONTROL_SUBTYPE)).not.toContain("turn-start");
    expect(TRIGGER_TURN_MARKER_SUBTYPE).toEqual({
      TURN_START: "turn-start",
      TURN_JOIN: "turn-join",
    });
  });
});
