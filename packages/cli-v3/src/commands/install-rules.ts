import { confirm, intro, isCancel, log, multiselect, outro } from "@clack/prompts";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import chalk from "chalk";
import { Command, Option as CommandOption } from "commander";
import { join } from "node:path";
import * as semver from "semver";
import { z } from "zod";
import { OutroCommandError, wrapCommandAction } from "../cli/common.js";
import { loadConfig } from "../config.js";
import {
  GithubRulesManifestLoader,
  loadRulesManifest,
  LocalRulesManifestLoader,
  ManifestVersion,
  RulesManifest,
  RulesManifestVersionOption,
} from "../rules/manifest.js";
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

const InstallRulesCommandOptions = z.object({
  target: z.enum(targets).array().optional(),
  manifestPath: z.string().optional(),
  branch: z.string().optional(),
  logLevel: z.enum(["debug", "info", "log", "warn", "error", "none"]).optional(),
  forceWizard: z.boolean().optional(),
});

type InstallRulesCommandOptions = z.infer<typeof InstallRulesCommandOptions>;

export function configureInstallRulesCommand(program: Command) {
  return program
    .command("install-rules")
    .description("Install the Trigger.dev Agent rules files")
    .option(
      "--target <targets...>",
      "Choose the target (or targets) to install the Trigger.dev rules into. We currently support: " +
        targets.join(", ")
    )
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .addOption(
      new CommandOption(
        "--manifest-path <path>",
        "The path to the rules manifest file. This is useful if you want to install the rules from a local file."
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--branch <branch>",
        "The branch to install the rules from, the default is main"
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--force-wizard",
        "Force the rules install wizard to run even if the rules have already been installed."
      ).hideHelp()
    )
    .action(async (options) => {
      await printStandloneInitialBanner(true);
      await installRulesCommand(options);
    });
}

export async function installRulesCommand(options: unknown) {
  return await wrapCommandAction(
    "installRulesCommand",
    InstallRulesCommandOptions,
    options,
    async (opts) => {
      if (opts.logLevel) {
        logger.loggerLevel = opts.logLevel;
      }

      return await _installRulesCommand(opts);
    }
  );
}

async function _installRulesCommand(options: InstallRulesCommandOptions) {
  if (options.forceWizard) {
    await initiateRulesInstallWizard(options);
    return;
  }

  intro("Welcome to the Trigger.dev Agent rules install wizard ");

  const manifestLoader = options.manifestPath
    ? new LocalRulesManifestLoader(options.manifestPath)
    : new GithubRulesManifestLoader(options.branch ?? "main");

  const manifest = await loadRulesManifest(manifestLoader);

  writeConfigLastRulesInstallPromptVersion(manifest.currentVersion);
  writeConfigHasSeenRulesInstallPrompt(true);

  await installRules(manifest, options);

  outro("You're all set! ");
}

type InstallRulesResults = Array<InstallRulesResult>;

type InstallRulesResult = {
  configPath: string;
  targetName: (typeof targets)[number];
};

export type InstallRulesWizardOptions = {
  target?: Array<(typeof targets)[number]>;
  manifestPath?: string;
  branch?: string;
};

export async function initiateRulesInstallWizard(options: InstallRulesWizardOptions) {
  const manifestLoader = options.manifestPath
    ? new LocalRulesManifestLoader(options.manifestPath)
    : new GithubRulesManifestLoader(options.branch ?? "main");

  const manifest = await loadRulesManifest(manifestLoader);

  const hasSeenRulesInstallPrompt = readConfigHasSeenRulesInstallPrompt();

  if (!hasSeenRulesInstallPrompt) {
    writeConfigHasSeenRulesInstallPrompt(true);
    writeConfigLastRulesInstallPromptVersion(manifest.currentVersion);

    const installChoice = await confirm({
      message: "Would you like to install the Trigger.dev code agent rules?",
      initialValue: true,
    });

    const skipInstall = isCancel(installChoice) || !installChoice;

    if (skipInstall) {
      return;
    }

    await installRules(manifest, options);
    return;
  }

  const lastRulesInstallPromptVersion = readConfigLastRulesInstallPromptVersion();

  if (!lastRulesInstallPromptVersion) {
    writeConfigHasSeenRulesInstallPrompt(true);
    writeConfigLastRulesInstallPromptVersion(manifest.currentVersion);

    const installChoice = await confirm({
      message: `A new version of the trigger.dev agent rules is available (${manifest.currentVersion}). Do you want to install it?`,
      initialValue: true,
    });

    const skipInstall = isCancel(installChoice) || !installChoice;

    if (skipInstall) {
      return;
    }

    await installRules(manifest, options);
    return;
  }

  if (semver.gt(manifest.currentVersion, lastRulesInstallPromptVersion)) {
    writeConfigHasSeenRulesInstallPrompt(true);
    writeConfigLastRulesInstallPromptVersion(manifest.currentVersion);

    const confirmed = await confirm({
      message: `A new version of the trigger.dev agent rules is available (${lastRulesInstallPromptVersion} → ${chalk.greenBright(
        manifest.currentVersion
      )}). Do you want to install it?`,
      initialValue: true,
    });

    if (isCancel(confirmed) || !confirmed) {
      return;
    }

    await installRules(manifest, options);
  }

  return;
}

async function installRules(manifest: RulesManifest, opts: InstallRulesWizardOptions) {
  const config = await loadConfig({
    cwd: process.cwd(),
  });

  const currentVersion = await manifest.getCurrentVersion();

  const targetNames = await resolveTargets(opts);

  if (targetNames.length === 1 && targetNames.includes("unsupported")) {
    handleUnsupportedTargetOnly(opts);
    return;
  }

  const results = [];

  for (const targetName of targetNames) {
    const result = await installRulesForTarget(targetName, currentVersion, config, opts);

    if (result) {
      results.push(result);
    }
  }

  if (results.length > 0) {
    log.step("Installed the following rules files:");

    for (const r of results) {
      const installationsByLocation = r.installations.reduce(
        (acc, i) => {
          if (!acc[i.location]) {
            acc[i.location] = [];
          }

          acc[i.location]!.push(i.option);

          return acc;
        },
        {} as Record<string, RulesManifestVersionOption[]>
      );

      const locationOutput = Object.entries(installationsByLocation).map(
        ([location]) => `${chalk.greenBright(location)}`
      );

      for (const message of locationOutput) {
        log.info(message);
      }
    }

    log.info(
      `${cliLink("Learn how to use our rules", "https://trigger.dev/docs/agents/rules/overview")}`
    );
  }
}

function handleUnsupportedTargetOnly(options: InstallRulesCommandOptions): InstallRulesResults {
  log.info(
    `${cliLink("Install the rules manually", "https://trigger.dev/docs/agents/rules/overview")}`
  );

  return [];
}

async function installRulesForTarget(
  targetName: ResolvedTargets,
  currentVersion: ManifestVersion,
  config: ResolvedConfig,
  options: InstallRulesCommandOptions
) {
  if (targetName === "unsupported") {
    // This should not happen as unsupported targets are handled separately
    // but if it does, provide helpful output
    log.message(
      `${chalk.yellow("⚠")} Skipping unsupported target - see manual configuration above`
    );
    return;
  }

  const result = await performInstallForTarget(targetName, currentVersion, config, options);

  return result;
}

async function performInstallForTarget(
  targetName: (typeof targets)[number],
  currentVersion: ManifestVersion,
  config: ResolvedConfig,
  cmdOptions: InstallRulesCommandOptions
) {
  const options = await resolveOptionsForTarget(targetName, currentVersion, cmdOptions);

  const installations = await performInstallOptionsForTarget(targetName, options, config);

  return {
    targetName,
    installations,
  };
}

async function performInstallOptionsForTarget(
  targetName: (typeof targets)[number],
  options: Array<RulesManifestVersionOption>,
  config: ResolvedConfig
) {
  const results = [];

  for (const option of options) {
    const result = await performInstallOptionForTarget(targetName, option, config);
    results.push(result);
  }

  return results;
}

async function performInstallOptionForTarget(
  targetName: (typeof targets)[number],
  option: RulesManifestVersionOption,
  config: ResolvedConfig
) {
  switch (option.installStrategy) {
    case "default": {
      return performInstallDefaultOptionForTarget(targetName, option, config);
    }
    case "claude-code-subagent": {
      return performInstallClaudeCodeSubagentOptionForTarget(option);
    }
    default: {
      throw new Error(`Unknown install strategy: ${option.installStrategy}`);
    }
  }
}

async function performInstallDefaultOptionForTarget(
  targetName: (typeof targets)[number],
  option: RulesManifestVersionOption,
  config: ResolvedConfig
) {
  // Get the path to the rules file
  const rulesFilePath = resolveRulesFilePathForTargetOption(targetName, option);
  const rulesFileContents = await resolveRulesFileContentsForTarget(targetName, option, config);
  const mergeStrategy = await resolveRulesFileMergeStrategyForTarget(targetName);

  // Try and read the existing rules file
  const rulesFileAbsolutePath = join(process.cwd(), rulesFilePath);
  await writeToFile(rulesFileAbsolutePath, rulesFileContents, mergeStrategy, option.name);

  return { option, location: rulesFilePath };
}

async function writeToFile(
  path: string,
  contents: string,
  mergeStrategy: "overwrite" | "replace" = "overwrite",
  sectionName: string
) {
  const exists = await pathExists(path);

  if (exists) {
    switch (mergeStrategy) {
      case "overwrite": {
        await safeWriteFile(path, contents);
        break;
      }
      case "replace": {
        const existingContents = await readFile(path);

        const pattern = new RegExp(
          `<!-- TRIGGER.DEV ${sectionName} START -->.*?<!-- TRIGGER.DEV ${sectionName} END -->`,
          "gs"
        );

        // If the section name is not found, just append the new content
        if (!pattern.test(existingContents)) {
          await safeWriteFile(path, existingContents + "\n\n" + contents);
          break;
        }

        const updatedContent = existingContents.replace(pattern, contents);

        await safeWriteFile(path, updatedContent);
        break;
      }
      default: {
        throw new Error(`Unknown merge strategy: ${mergeStrategy}`);
      }
    }
  } else {
    await safeWriteFile(path, contents);
  }
}

async function performInstallClaudeCodeSubagentOptionForTarget(option: RulesManifestVersionOption) {
  const rulesFilePath = ".claude/agents/trigger-dev-task-writer.md";
  const rulesFileContents = option.contents;

  await writeToFile(rulesFilePath, rulesFileContents, "overwrite", option.name);

  return { option, location: rulesFilePath };
}

function resolveRulesFilePathForTargetOption(
  targetName: (typeof targets)[number],
  option: RulesManifestVersionOption
): string {
  if (option.installStrategy === "claude-code-subagent") {
    return ".claude/agents/trigger-dev-task-writer.md";
  }

  switch (targetName) {
    case "claude-code": {
      return "CLAUDE.md";
    }
    case "cursor": {
      return `.cursor/rules/trigger.${option.name}.mdc`;
    }
    case "vscode": {
      return `.github/instructions/trigger-${option.name}.instructions.md`;
    }
    case "windsurf": {
      return `.windsurf/rules/trigger-${option.name}.md`;
    }
    case "gemini-cli": {
      return `GEMINI.md`;
    }
    case "cline": {
      return `.clinerules/trigger-${option.name}.md`;
    }
    case "agents.md": {
      return "AGENTS.md";
    }
    case "amp": {
      return "AGENT.md";
    }
    case "kilo": {
      return `.kilocode/rules/trigger-${option.name}.md`;
    }
    case "ruler": {
      return `.ruler/trigger-${option.name}.md`;
    }
    default: {
      throw new Error(`Unknown target: ${targetName}`);
    }
  }
}

async function resolveRulesFileMergeStrategyForTarget(targetName: (typeof targets)[number]) {
  switch (targetName) {
    case "amp":
    case "agents.md":
    case "gemini-cli":
    case "claude-code": {
      return "replace";
    }
    default: {
      return "overwrite";
    }
  }
}

async function resolveRulesFileContentsForTarget(
  targetName: (typeof targets)[number],
  option: RulesManifestVersionOption,
  config: ResolvedConfig
) {
  switch (targetName) {
    case "cursor": {
      return $output(
        frontmatter({
          description: option.label,
          globs: option.applyTo ?? "**/trigger/**/*.ts",
          alwaysApply: false,
        }),
        option.contents
      );
    }
    case "vscode": {
      return $output(
        frontmatter({
          applyTo: option.applyTo ?? "**/trigger/**/*.ts",
        }),
        option.contents
      );
    }
    case "windsurf": {
      return $output(
        frontmatter({
          trigger: "glob",
          globs: option.applyTo ?? "**/trigger/**/*.ts",
        }),
        option.contents
      );
    }
    default: {
      return $output(
        `<!-- TRIGGER.DEV ${option.name} START -->`,
        option.contents,
        `<!-- TRIGGER.DEV ${option.name} END -->`
      );
    }
  }
}

function frontmatter(data: Record<string, string | boolean>) {
  return $output("---", ...Object.entries(data).map(([key, value]) => `${key}: ${value}`), "---");
}

function $output(...strings: string[]) {
  return strings.map((s) => s).join("\n");
}

async function resolveOptionsForTarget(
  targetName: (typeof targets)[number],
  currentVersion: ManifestVersion,
  cmdOptions: InstallRulesCommandOptions
) {
  const possibleOptions = currentVersion.options.filter(
    (option) => !option.client || option.client === targetName
  );

  const selectedOptions = await multiselect({
    message: `Choose the rules you want to install for ${targetLabels[targetName]}`,
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

async function resolveTargets(options: InstallRulesCommandOptions): Promise<ResolvedTargets[]> {
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
    hint: "We don't support this target yet, but you can still install the rules manually.",
  });

  const $selectOptions = selectOptions as Array<{
    value: ResolvedTargets;
    label: string;
    hint?: string;
  }>;

  const selectedTargets = await multiselect({
    message: "Select one or more targets to install the rules into",
    options: $selectOptions,
    required: true,
  });

  if (isCancel(selectedTargets)) {
    throw new OutroCommandError("No targets selected");
  }

  return selectedTargets;
}
