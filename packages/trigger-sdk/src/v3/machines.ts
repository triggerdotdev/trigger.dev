import type { NamedMachine } from "@trigger.dev/core/v3";

export type { NamedMachine };

/**
 * Defines a machine: an image built on top of the project image, and the preset tasks on it use by
 * default. Set it as a task's `machine` and the deploy builds its image.
 *
 * Only native builds (`--native-build`) and local builds (`--local-build`) build machine images.
 * In `trigger.dev dev`, tasks run on your machine, so the image changes do not apply.
 *
 * @example
 * ```ts
 * export const codingBox = defineMachine({
 *   id: "coding-box",
 *   preset: "medium-2x",
 *   image: { pkgs: ["ripgrep"], instructions: ["RUN npm install -g @anthropic-ai/claude-code"] },
 * });
 *
 * export const fixBug = task({ id: "fix-bug", machine: codingBox, run: async () => {} });
 * ```
 */
export function defineMachine<const TMachine extends NamedMachine>(machine: TMachine): TMachine {
  return machine;
}
