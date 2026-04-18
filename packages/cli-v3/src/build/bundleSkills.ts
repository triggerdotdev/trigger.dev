import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { BuildManifest, SkillManifest } from "@trigger.dev/core/v3/schemas";
import { copyDirectoryRecursive } from "@trigger.dev/build/internal";
import { indexWorkerManifest } from "../indexing/indexWorkerManifest.js";
import { execOptionsForRuntime, type BuildLogger } from "@trigger.dev/core/v3/build";

export type BundleSkillsOptions = {
  buildManifest: BuildManifest;
  buildManifestPath: string;
  workingDir: string;
  env: Record<string, string | undefined>;
  logger: BuildLogger;
};

export type BundleSkillsResult = {
  /** The input manifest, annotated with `skills` on return. */
  buildManifest: BuildManifest;
  /** Discovered skills, in deterministic order. */
  skills: SkillManifest[];
};

/**
 * Built-in skill bundler — not an extension. Runs the indexer locally
 * against the bundled worker output to discover `ai.defineSkill(...)`
 * registrations, validates each skill's `SKILL.md`, and copies the
 * folder into `{outputPath}/.trigger/skills/{id}/` so the deploy image
 * picks it up via the existing Dockerfile `COPY`.
 *
 * No `trigger.config.ts` changes required — discovery is side-effect
 * based, same mechanism as task/prompt registration.
 */
export async function bundleSkills(
  options: BundleSkillsOptions
): Promise<BundleSkillsResult> {
  const { buildManifest, buildManifestPath, workingDir, env, logger } = options;

  let skills: SkillManifest[];
  try {
    const workerManifest = await indexWorkerManifest({
      runtime: buildManifest.runtime,
      indexWorkerPath: buildManifest.indexWorkerEntryPoint,
      buildManifestPath,
      nodeOptions: execOptionsForRuntime(buildManifest.runtime, buildManifest),
      env,
      cwd: workingDir,
      otelHookInclude: buildManifest.otelImportHook?.include,
      otelHookExclude: buildManifest.otelImportHook?.exclude,
      handleStdout(data) {
        logger.debug(`[bundleSkills] ${data}`);
      },
      handleStderr(data) {
        if (!data.includes("Debugger attached")) {
          logger.debug(`[bundleSkills:stderr] ${data}`);
        }
      },
    });
    skills = workerManifest.skills ?? [];
  } catch (err) {
    // Skill discovery via the indexer is best-effort — if the user's
    // bundle doesn't load cleanly here the downstream full indexer will
    // surface the real error. Warn and continue with no skills.
    logger.debug(`[bundleSkills] skill discovery failed: ${(err as Error).message}`);
    return { buildManifest, skills: [] };
  }

  if (skills.length === 0) {
    return { buildManifest, skills: [] };
  }

  const destinationRoot = join(buildManifest.outputPath, ".trigger", "skills");

  for (const skill of skills) {
    const sourcePath = resolvePath(workingDir, skill.sourcePath);
    const skillMdPath = join(sourcePath, "SKILL.md");

    let skillMd: string;
    try {
      skillMd = await readFile(skillMdPath, "utf8");
    } catch {
      throw new Error(
        `Skill "${skill.id}": SKILL.md not found at ${skillMdPath}. ` +
          `Registered via ai.defineSkill({ id: "${skill.id}", path: "${skill.sourcePath}" }) ` +
          `at ${skill.filePath}.`
      );
    }

    if (!/^---\r?\n[\s\S]*?\r?\n---/.test(skillMd)) {
      throw new Error(
        `Skill "${skill.id}": SKILL.md at ${skillMdPath} is missing a frontmatter block.`
      );
    }
    if (!/\bname:\s*\S/.test(skillMd) || !/\bdescription:\s*\S/.test(skillMd)) {
      throw new Error(
        `Skill "${skill.id}": SKILL.md at ${skillMdPath} frontmatter must include both \`name\` and \`description\`.`
      );
    }

    const skillDest = join(destinationRoot, skill.id);
    logger.debug(`[bundleSkills] Copying ${sourcePath} → ${skillDest}`);
    await copyDirectoryRecursive(sourcePath, skillDest);
  }

  // Sort by id for deterministic manifest output
  skills = [...skills].sort((a, b) => a.id.localeCompare(b.id));

  // Content hash is derived from each SKILL.md's content for cache invalidation
  // downstream (dashboard persistence in Phase 2). Not used in Phase 1.
  void createHash;
  void dirname;

  return {
    buildManifest: { ...buildManifest, skills },
    skills,
  };
}
