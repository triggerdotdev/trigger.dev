import { describe, expect, it } from "vitest";
import { collectTaskMachines } from "./machines.js";

describe("collectTaskMachines", () => {
  // Catches: one image built per machine id when two tasks define it differently
  it("rejects two different machines with the same id", () => {
    expect(() =>
      collectTaskMachines([
        { id: "a", namedMachine: { id: "box", image: { pkgs: ["ripgrep"] } } },
        { id: "b", namedMachine: { id: "box", image: { pkgs: ["jq"] } } },
      ])
    ).toThrow(/"a" and "b"/);
  });

  it("collects a machine shared by several tasks once", () => {
    const machine = { id: "box", preset: "medium-2x" as const, image: { pkgs: ["ripgrep"] } };

    expect(
      collectTaskMachines([
        { id: "a", namedMachine: machine },
        { id: "b", namedMachine: { ...machine } },
        { id: "c" },
      ])
    ).toEqual([machine]);
  });
});
