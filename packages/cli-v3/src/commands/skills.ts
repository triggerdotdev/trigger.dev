import { confirm, intro, isCancel, log, multiselect, outro } from "@clack/prompts";
import chalk from "chalk";
import { Command, Option as CommandOption } from "commander";
import { dirname, join } from "node:path";
import { readPackageJSON, resolvePackageJSON } from "pkg-types";
import * as semver from "semver";
import { z } from "zod";
import { OutroCommandError, wrapCommandAction } from "../cli/common.js";
import {
  BundledSkillsLoader,
  loadRulesManifest,
  ManifestVersion,
  RulesManifest,
  RulesManifestVersionOption,
} from "../rules/manifest.js";
import { sourceDir } from "../sourceDir.js";
import { cliLink } from "../utilities/cliOutput.js";
import {
  readConfigHasSeenRulesInstallPrompt,
  readConfigLastRulesInstallPromptVersion,
  writeConfigHasSeenRulesInstallPrompt,
  writeConfigLastRulesInstallPromptVersion,
} from "../utilities/configFiles.js";
import { pathExists, readFile, safeWriteFile } from "../utilities/fileSystem.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";

const targets = [
  "claude-code",
  "cursor",
  "vscode",
  "windsurf",
  "gemini-cli",
  "cline",
  "agents.md",
  "amp",
  "kilo",
  "ruler",
] as const;

type TargetLabels = {
  [key in (typeof targets)[number]]: string;
};

const targetLabels: TargetLabels = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VSCode",
  windsurf: "Windsurf",
  "gemini-cli": "Gemini CLI",
  cline: "Cline",
  "agents.md": "AGENTS.md (OpenAI Codex CLI, Jules, OpenCode)",
  amp: "Sourcegraph AMP",
  kilo: "Kilo Code",
  ruler: "Ruler",
};

type SupportedTargets = (typeof targets)[number];
type ResolvedTargets = SupportedTargets | "unsupported";

const SkillsCommandOptions = z.object({
  target: z.enum(targets).array().optional(),
  yes: z.boolean().optional(),
  logLevel: z.enum(["debug", "info", "log", "warn", "error", "none"]).optional(),
  forceWizard: z.boolean().optional(),
});

type SkillsCommandOptions = z.infer<typeof SkillsCommandOptions>;

export function configureSkillsCommand(program: Command) {
  return program
    .command("skills")
    .alias("install-rules")
    .description("Install the Trigger.dev agent skills into your coding agent")
    .option(
      "--target <targets...>",
      "Choose the target (or targets) to install the Trigger.dev skills into. We currently support: " +
        targets.join(", ")
    )
    .option(
      "-y, --yes",
      "Install all available skills for the selected targets without prompting"
    )
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .addOption(
      new CommandOption(
        "--force-wizard",
        "Force the skills install wizard to run even if the skills have already been installed."
      ).hideHelp()
    )
    .action(async (options) => {
      await printStandloneInitialBanner(true);
      await installSkillsCommand(options);
    });
}

export async function installSkillsCommand(options: unknown) {
  return await wrapCommandAction("installSkillsCommand", SkillsCommandOptions, options, async (opts) => {
    if (opts.logLevel) {
      logger.loggerLevel = opts.logLevel;
    }

    return await _installSkillsCommand(opts);
  });
}

/**
 * Loads the agent skills bundled in this CLI (`<cli>/skills`, shipped via `files[]`).
 * The skills dir and version are resolved from the CLI's own package.json, anchored at
 * `sourceDir` (the CLI's location) rather than the user's cwd. The CLI is the only source
 * of skills (there is no remote fallback), so this only returns null in the unexpected
 * case that the CLI ships without any skills.
 */
async function loadSkillsManifest(): Promise<RulesManifest | null> {
  try {
    const packageJsonPath = await resolvePackageJSON(sourceDir);
    const pkg = await readPackageJSON(packageJsonPath);
    const skillsDir = join(dirname(packageJsonPath), "skills");
    const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";

    return await loadRulesManifest(new BundledSkillsLoader(skillsDir, version));
  } catch {
    return null;
  }
}

async function _installSkillsCommand(options: SkillsCommandOptions) {
  if (options.forceWizard) {
    await initiateSkillsInstallWizard(options);
    return;
  }

  intro("Welcome to the Trigger.dev agent skills installer ");

  const manifest = await loadSkillsManifest();

  if (!manifest) {
    log.warn("No Trigger.dev agent skills were found in this CLI build.");
    outro("Nothing to install.");
    return;
  }

  writeConfigLastRulesInstallPromptVersion(manifest.currentVersion);
  writeConfigHasSeenRulesInstallPrompt(true);

  await installSkills(manifest, options);

  outro("You're all set! ");
}

export type SkillsWizardOptions = {
  target?: Array<(typeof targets)[number]>;
  yes?: boolean;
};

export async function initiateSkillsInstallWizard(options: SkillsWizardOptions) {
  const manifest = await loadSkillsManifest();

  // The CLI couldn't load its own bundled skills (unexpected); nothing to offer.
  if (!manifest) {
    return;
  }

  const hasSeenPrompt = readConfigHasSeenRulesInstallPrompt();

  if (!hasSeenPrompt) {
    writeConfigHasSeenRulesInstallPrompt(true);
    writeConfigLastRulesInstallPromptVersion(manifest.currentVersion);

    const installChoice = await confirm({
      message: "Would you like to install the Trigger.dev agent skills?",
      initialValue: true,
    });

    if (isCancel(installChoice) || !installChoice) {
      return;
    }

    await installSkills(manifest, options);
    return;
  }

  const lastVersion = readConfigLastRulesInstallPromptVersion();

  if (!lastVersion) {
    writeConfigHasSeenRulesInstallPrompt(true);
    writeConfigLastRulesInstallPromptVersion(manifest.currentVersion);

    const installChoice = await confirm({
      message: `A new version of the Trigger.dev agent skills is available (${manifest.currentVersion}). Do you want to install it?`,
      initialValue: true,
    });

    if (isCancel(installChoice) || !installChoice) {
      return;
    }

    await installSkills(manifest, options);
    return;
  }

  if (semver.gt(manifest.currentVersion, lastVersion)) {
    writeConfigHasSeenRulesInstallPrompt(true);
    writeConfigLastRulesInstallPromptVersion(manifest.currentVersion);

    const confirmed = await confirm({
      message: `A new version of the Trigger.dev agent skills is available (${lastVersion} → ${chalk.greenBright(
        manifest.currentVersion
      )}). Do you want to install it?`,
      initialValue: true,
    });

    if (isCancel(confirmed) || !confirmed) {
      return;
    }

    await installSkills(manifest, options);
  }
}

async function installSkills(manifest: RulesManifest, opts: SkillsWizardOptions) {
  const currentVersion = await manifest.getCurrentVersion();

  const targetNames = await resolveTargets(opts);

  if (targetNames.length === 1 && targetNames.includes("unsupported")) {
    handleUnsupportedTargetOnly();
    return;
  }

  const results = [];

  for (const targetName of targetNames) {
    const result = await installSkillsForTarget(targetName, currentVersion, opts);

    if (result) {
      results.push(result);
    }
  }

  if (results.length > 0) {
    log.step("Installed the following skills:");

    for (const r of results) {
      for (const installation of r.installations) {
        log.info(chalk.greenBright(installation.location));
      }
      if (r.pointer) {
        log.info(`${chalk.greenBright(r.pointer)} ${chalk.dim("(always-on pointer)")}`);
      }
    }

    log.info(
      `${cliLink("Learn how to use Trigger.dev skills", "https://trigger.dev/docs/agents/rules/overview")}`
    );
  }
}

function handleUnsupportedTargetOnly() {
  log.info(
    `${cliLink("Install the skills manually", "https://trigger.dev/docs/agents/rules/overview")}`
  );
}

async function installSkillsForTarget(
  targetName: ResolvedTargets,
  currentVersion: ManifestVersion,
  opts: SkillsWizardOptions
) {
  if (targetName === "unsupported") {
    // This should not happen as unsupported targets are handled separately,
    // but if it does, provide helpful output.
    log.message(`${chalk.yellow("⚠")} Skipping unsupported target - see manual configuration above`);
    return;
  }

  const options = await resolveOptionsForTarget(targetName, currentVersion, opts);

  const installations = [];

  for (const option of options) {
    const installation = await performInstallSkillsOptionForTarget(targetName, option);

    if (installation) {
      installations.push(installation);
    }
  }

  // Skills load on demand, so drop one always-on pointer into the tool's primary
  // instructions file announcing what's installed (decision 7). Body lives in the
  // on-demand skills; only this one-liner is always in context.
  let pointer: string | undefined;
  const skillsDir = resolveSkillsDirForTarget(targetName);
  if (installations.length > 0 && skillsDir) {
    pointer = await writeSkillsPointer(
      targetName,
      skillsDir,
      installations.map((i) => i.option.name)
    );
  }

  return { targetName, installations, pointer };
}

/**
 * Skills are whole folders (SKILL.md + optional references). We write the SKILL.md into
 * the target tool's native skills directory under the skill's own folder so the tool
 * discovers it. Targets without a native skills dir are skipped with a notice.
 */
async function performInstallSkillsOptionForTarget(
  targetName: (typeof targets)[number],
  option: RulesManifestVersionOption
) {
  const skillsDir = resolveSkillsDirForTarget(targetName);

  if (!skillsDir) {
    log.message(
      `${chalk.yellow("⚠")} ${targetLabels[targetName]} doesn't support agent skills yet, skipping "${option.name}".`
    );
    return;
  }

  const location = join(skillsDir, option.name, "SKILL.md");

  await safeWriteFile(join(process.cwd(), location), option.contents);

  return { option, location };
}

function resolveSkillsDirForTarget(targetName: (typeof targets)[number]): string | undefined {
  switch (targetName) {
    case "claude-code": {
      return ".claude/skills";
    }
    case "cursor": {
      return ".cursor/skills";
    }
    case "vscode": {
      return ".github/skills";
    }
    case "agents.md": {
      return ".agents/skills";
    }
    default: {
      return undefined;
    }
  }
}

const POINTER_START = "<!-- TRIGGER.DEV SKILLS START -->";
const POINTER_END = "<!-- TRIGGER.DEV SKILLS END -->";

type SkillsPointer = { file: string; mode: "region" | "dedicated" };

/**
 * The always-on instructions file for each skills-capable target. "region" files are
 * shared (a marked block is upserted so we never clobber other content); "dedicated"
 * files are ours to own and overwrite.
 */
function resolveSkillsPointerForTarget(targetName: (typeof targets)[number]): SkillsPointer | undefined {
  switch (targetName) {
    case "claude-code": {
      return { file: "CLAUDE.md", mode: "region" };
    }
    case "cursor": {
      return { file: ".cursor/rules/trigger-skills.mdc", mode: "dedicated" };
    }
    case "vscode": {
      return { file: ".github/copilot-instructions.md", mode: "region" };
    }
    case "agents.md": {
      return { file: "AGENTS.md", mode: "region" };
    }
    default: {
      return undefined;
    }
  }
}

function buildSkillsPointerBody(skillsDir: string, skillNames: string[]): string {
  const list = skillNames.map((n) => `\`${n}\``).join(", ");
  return [
    "## Trigger.dev agent skills",
    "",
    `This project has Trigger.dev agent skills installed in \`${skillsDir}/\`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: ${list}.`,
  ].join("\n");
}

/**
 * Writes/updates the one-line always-on pointer for a target. Idempotent: region files
 * replace the marked block (or append it once); the dedicated Cursor rule is overwritten.
 * Returns the written path, or undefined for targets without a pointer location.
 */
async function writeSkillsPointer(
  targetName: (typeof targets)[number],
  skillsDir: string,
  skillNames: string[]
): Promise<string | undefined> {
  const pointer = resolveSkillsPointerForTarget(targetName);
  if (!pointer) {
    return undefined;
  }

  const body = buildSkillsPointerBody(skillsDir, skillNames);
  const absolutePath = join(process.cwd(), pointer.file);

  if (pointer.mode === "dedicated") {
    // Cursor: a dedicated always-apply rule file we own outright.
    const contents = [
      "---",
      "description: Trigger.dev agent skills are installed in this repo",
      "alwaysApply: true",
      "---",
      "",
      body,
      "",
    ].join("\n");
    await safeWriteFile(absolutePath, contents);
    return pointer.file;
  }

  const block = `${POINTER_START}\n${body}\n${POINTER_END}`;

  if (!(await pathExists(absolutePath))) {
    await safeWriteFile(absolutePath, `${block}\n`);
    return pointer.file;
  }

  const existing = await readFile(absolutePath);
  const pattern = new RegExp(`${POINTER_START}.*?${POINTER_END}`, "s");
  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : `${existing.trimEnd()}\n\n${block}\n`;

  await safeWriteFile(absolutePath, next);
  return pointer.file;
}

async function resolveOptionsForTarget(
  targetName: (typeof targets)[number],
  currentVersion: ManifestVersion,
  opts: SkillsWizardOptions
) {
  const possibleOptions = currentVersion.options.filter(
    (option) => !option.client || option.client === targetName
  );

  // Non-interactive: install everything available for this target.
  if (opts.yes) {
    return possibleOptions;
  }

  const selectedOptions = await multiselect({
    message: `Choose the skills you want to install for ${targetLabels[targetName]}`,
    options: possibleOptions.map((option) => ({
      value: option,
      label: option.title,
      hint: `${option.label} [~${option.tokens} tokens]`,
    })),
    required: true,
  });

  if (isCancel(selectedOptions)) {
    throw new OutroCommandError("No options selected");
  }

  return selectedOptions;
}

async function resolveTargets(options: SkillsWizardOptions): Promise<ResolvedTargets[]> {
  if (options.target) {
    return options.target;
  }

  const selectOptions: Array<{
    value: string;
    label: string;
    hint?: string;
  }> = targets.map((target) => ({
    value: target,
    label: targetLabels[target],
  }));

  selectOptions.push({
    value: "unsupported",
    label: "Unsupported target",
    hint: "We don't support this target yet, but you can still install the skills manually.",
  });

  const $selectOptions = selectOptions as Array<{
    value: ResolvedTargets;
    label: string;
    hint?: string;
  }>;

  const selectedTargets = await multiselect({
    message: "Select one or more targets to install the skills into",
    options: $selectOptions,
    required: true,
  });

  if (isCancel(selectedTargets)) {
    throw new OutroCommandError("No targets selected");
  }

  return selectedTargets;
}
