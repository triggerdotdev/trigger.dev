import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
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

export type CopySkillFoldersOptions = {
  skills: SkillManifest[];
  /** Root where `{destinationRoot}/{id}/` folders will be created. */
  destinationRoot: string;
  /** Used to resolve relative `filePath` references in skill manifests. */
  workingDir: string;
  /** Only `debug` is used. `BuildLogger` and the cli `logger` both satisfy this shape. */
  logger: { debug: (...args: unknown[]) => void };
};

/**
 * Copy each skill's source folder to `{destinationRoot}/{id}/`. Validates
 * that `SKILL.md` exists and has the required frontmatter. Pure file IO —
 * no indexer subprocess, no env handling.
 *
 * Used by the dev path (driven by the main worker indexer's skills list)
 * and indirectly by the deploy path (via `bundleSkills` which discovers
 * skills via its own indexer pass first, then delegates here).
 */
export async function copySkillFolders(
  options: CopySkillFoldersOptions
): Promise<SkillManifest[]> {
  const { skills, destinationRoot, workingDir, logger } = options;

  if (skills.length === 0) {
    return [];
  }

  for (const skill of skills) {
    const callerDir = skill.filePath
      ? resolvePath(workingDir, skill.filePath, "..")
      : workingDir;
    const sourcePath = isAbsolute(skill.sourcePath)
      ? skill.sourcePath
      : resolvePath(callerDir, skill.sourcePath);
    const skillMdPath = join(sourcePath, "SKILL.md");

    let skillMd: string;
    try {
      skillMd = await readFile(skillMdPath, "utf8");
    } catch {
      throw new Error(
        `Skill "${skill.id}": SKILL.md not found at ${skillMdPath}. ` +
          `Registered via skills.define({ id: "${skill.id}", path: "${skill.sourcePath}" }) ` +
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
    logger.debug(`[copySkillFolders] Copying ${sourcePath} → ${skillDest}`);
    await copyDirectoryRecursive(sourcePath, skillDest);
  }

  return [...skills].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Built-in skill bundler — not an extension. Runs the indexer locally
 * against the bundled worker output to discover `skills.define(...)`
 * registrations, validates each skill's `SKILL.md`, and copies the
 * folder into `{outputPath}/.trigger/skills/{id}/` so the deploy image
 * picks it up via the existing Dockerfile `COPY`.
 *
 * Used by the deploy path. The dev path uses `copySkillFolders` directly,
 * driven by the main worker indexer that already runs in `BackgroundWorker.initialize` —
 * no duplicate indexer pass needed there.
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
    // surface the real error. Warn so the user sees what went wrong.
    logger.warn(
      `[bundleSkills] skill discovery failed, skipping skill bundling: ${(err as Error).message}`
    );
    return { buildManifest, skills: [] };
  }

  if (skills.length === 0) {
    return { buildManifest, skills: [] };
  }

  // Deploy target: the Dockerfile COPY picks up everything under outputPath
  // into /app, so we target {outputPath}/.trigger/skills/{id}/ and the
  // container's cwd (/app) resolves correctly.
  const destinationRoot = join(buildManifest.outputPath, ".trigger", "skills");

  const sortedSkills = await copySkillFolders({
    skills,
    destinationRoot,
    workingDir,
    logger,
  });

  return {
    buildManifest: { ...buildManifest, skills: sortedSkills },
    skills: sortedSkills,
  };
}
