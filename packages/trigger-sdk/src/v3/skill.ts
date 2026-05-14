import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resourceCatalog } from "@trigger.dev/core/v3";

/**
 * Parsed `SKILL.md` frontmatter. Only `name` + `description` are required;
 * additional keys are preserved but untyped.
 */
export type SkillFrontmatter = {
  name: string;
  description: string;
  [key: string]: unknown;
};

/**
 * A resolved skill ready to hand to `chat.skills.set()`. Includes the parsed
 * SKILL.md content plus the on-disk path to the bundled skill folder.
 */
export type ResolvedSkill = {
  id: string;
  /** Skill version — `"local"` in Phase 1 until backend-managed overrides land. */
  version: number | "local";
  /** Labels applied to this version — empty in Phase 1. */
  labels: string[];
  /** Full raw `SKILL.md` content (with frontmatter). */
  skillMd: string;
  /** Parsed frontmatter fields. */
  frontmatter: SkillFrontmatter;
  /** Body of SKILL.md with the frontmatter block stripped. */
  body: string;
  /** Absolute path to the bundled skill folder (scripts, references, assets live here). */
  path: string;
};

export type SkillOptions<TIdentifier extends string = string> = {
  id: TIdentifier;
  /** Path to the skill source folder, relative to the project root. */
  path: string;
};

export type SkillHandle<TIdentifier extends string = string> = {
  id: TIdentifier;
  /**
   * Read the bundled `SKILL.md` from disk and return the resolved skill.
   *
   * This is the Phase 1 path — backend-managed overrides are not available
   * yet. Works locally (during `trigger dev`) and in the deploy image.
   */
  local(): Promise<ResolvedSkill>;
  /**
   * Resolve the skill against the dashboard (current/override version).
   *
   * Not available in Phase 1 — throws. Use `local()` until backend-managed
   * skills ship.
   */
  resolve(): Promise<ResolvedSkill>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySkillHandle = SkillHandle<string>;

/** Extract the id literal type from a SkillHandle. */
export type SkillIdentifier<T extends AnySkillHandle> = T extends SkillHandle<infer TId>
  ? TId
  : string;

/**
 * Bundled skills are copied to `${cwd}/.trigger/skills/{id}/` by the CLI at
 * build time. At runtime the same layout holds for both `trigger dev` (cwd
 * = dev output dir) and deploy (cwd = /app).
 */
function bundledSkillPath(id: string): string {
  return path.resolve(process.cwd(), ".trigger", "skills", id);
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n*/;

/**
 * Parse a minimal YAML-subset frontmatter block. We only support top-level
 * string keys like `name: foo` and `description: bar`. Enough for SKILL.md
 * frontmatter without pulling in a YAML dep.
 */
export function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match || !match[1]) {
    throw new Error(
      "Skill: SKILL.md is missing a frontmatter block. " +
        "Expected `---\\nname: ...\\ndescription: ...\\n---` at the top of the file."
    );
  }

  const raw = match[1];
  const frontmatter: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }

  if (typeof frontmatter.name !== "string" || !frontmatter.name) {
    throw new Error("Skill: SKILL.md frontmatter is missing required `name` field.");
  }
  if (typeof frontmatter.description !== "string" || !frontmatter.description) {
    throw new Error("Skill: SKILL.md frontmatter is missing required `description` field.");
  }

  const body = content.slice(match[0].length);

  return { frontmatter: frontmatter as SkillFrontmatter, body };
}

async function loadLocal(id: string): Promise<ResolvedSkill> {
  const skillPath = bundledSkillPath(id);
  const skillMdPath = path.join(skillPath, "SKILL.md");

  let skillMd: string;
  try {
    skillMd = await fs.readFile(skillMdPath, "utf8");
  } catch (err) {
    throw new Error(
      `Skill "${id}": could not read SKILL.md at ${skillMdPath}. ` +
        `Skills must be bundled into .trigger/skills/{id}/ — this usually means ` +
        `the CLI build step didn't run, or the skill wasn't registered via ai.defineSkill. ` +
        `Underlying error: ${(err as Error).message}`
    );
  }

  const { frontmatter, body } = parseFrontmatter(skillMd);

  return {
    id,
    version: "local",
    labels: [],
    skillMd,
    frontmatter,
    body,
    path: skillPath,
  };
}

/**
 * Define an agent skill — a developer-authored folder with a `SKILL.md` file
 * plus optional `scripts/`, `references/`, and `assets/` subfolders. Registers
 * the skill with the resource catalog so the Trigger.dev CLI can bundle it
 * into the deploy image automatically (no build extension needed).
 *
 * Call `.local()` on the returned handle to load the bundled SKILL.md at
 * runtime and use it with `chat.skills.set()`.
 *
 * @example
 * ```ts
 * // trigger/skills/pdf-processing/SKILL.md
 * // trigger/skills/pdf-processing/scripts/extract.py
 * import { ai } from "@trigger.dev/sdk";
 *
 * export const pdfSkill = ai.defineSkill({
 *   id: "pdf-processing",
 *   path: "./skills/pdf-processing",
 * });
 *
 * export const agent = chat.agent({
 *   id: "docs",
 *   onChatStart: async () => {
 *     chat.skills.set([await pdfSkill.local()]);
 *   },
 *   run: async ({ messages, signal }) => {
 *     return streamText({
 *       model: openai("gpt-4o"),
 *       messages,
 *       abortSignal: signal,
 *       ...chat.toStreamTextOptions(),
 *     });
 *   },
 * });
 * ```
 */
export function defineSkill<TIdentifier extends string>(
  options: SkillOptions<TIdentifier>
): SkillHandle<TIdentifier> {
  resourceCatalog.registerSkillMetadata({
    id: options.id,
    sourcePath: options.path,
  });

  return {
    id: options.id,
    async local() {
      return loadLocal(options.id);
    },
    async resolve() {
      throw new Error(
        `Skill "${options.id}": resolve() is not available yet — backend-managed ` +
          `skills ship in Phase 2. Use skill.local() instead.`
      );
    },
  };
}
