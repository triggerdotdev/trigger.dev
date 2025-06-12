import { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";

export type SyncEnvVarsBody =
  | Record<string, string>
  | Array<{ name: string; value: string; isParentEnv?: boolean }>;

export type SyncEnvVarsResult =
  | SyncEnvVarsBody
  | Promise<void | undefined | SyncEnvVarsBody>
  | void
  | undefined;

export type SyncEnvVarsParams = {
  projectRef: string;
  environment: string;
  branch?: string;
  env: Record<string, string>;
};

const UNSYNCABLE_ENV_VARS = [
  "PWD",
  "MallocNanoZone",
  "USER",
  "LANG",
  "__CFBundleIdentifier",
  "COMMAND_MODE",
  "PATH",
  "LOGNAME",
  "SSLKEYLOGFILE",
  "SSH_AUTH_SOCK",
  "SHLVL",
  "SHELL",
  "HOME",
  "__CF_USER_TEXT_ENCODING",
  "XPC_SERVICE_NAME",
  "XPC_FLAGS",
  "ORIGINAL_XDG_CURRENT_DESKTOP",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "GIT_ASKPASS",
  "VSCODE_GIT_ASKPASS_NODE",
  "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
  "VSCODE_GIT_ASKPASS_MAIN",
  "VSCODE_GIT_IPC_HANDLE",
  "VSCODE_INJECTION",
  "ZDOTDIR",
  "USER_ZDOTDIR",
  "TERM",
  "OLDPWD",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "MANPATH",
  "INFOPATH",
  "__GIT_PROMPT_DIR",
  "GIT_PROMPT_EXECUTABLE",
  "NVM_DIR",
  "NVM_CD_FLAGS",
  "NVM_BIN",
  "NVM_INC",
  "BUN_INSTALL",
  "DENO_INSTALL",
  "GITHUB_TOKEN",
  "TMPDIR",
  "_",
];

const UNSYNCABLE_ENV_VARS_PREFIXES = ["TRIGGER_"];

export type SyncEnvVarsFunction = (params: SyncEnvVarsParams) => SyncEnvVarsResult;

export type SyncEnvVarsOptions = {
  override?: boolean;
};

export function syncEnvVars(fn: SyncEnvVarsFunction, options?: SyncEnvVarsOptions): BuildExtension {
  return {
    name: "SyncEnvVarsExtension",
    async onBuildComplete(context, manifest) {
      if (context.target === "dev") {
        return;
      }

      const $spinner = context.logger.spinner("Invoking syncEnvVars callback");

      const result = await callSyncEnvVarsFn(
        fn,
        manifest.deploy.env ?? {},
        manifest.environment,
        manifest.branch,
        context
      );

      if (!result) {
        $spinner.stop("No env vars detected");

        return;
      }

      const env = stripUnsyncableEnvVars(result.env);
      const parentEnv = result.parentEnv ? stripUnsyncableEnvVars(result.parentEnv) : undefined;

      const numberOfEnvVars =
        Object.keys(env).length + (parentEnv ? Object.keys(parentEnv).length : 0);

      if (numberOfEnvVars === 0) {
        $spinner.stop("No env vars detected");

        return;
      } else if (numberOfEnvVars === 1) {
        $spinner.stop(`Found 1 env var`);
      } else {
        $spinner.stop(`Found ${numberOfEnvVars} env vars to sync`);
      }

      context.addLayer({
        id: "sync-env-vars",
        deploy: {
          env,
          parentEnv,
          override: options?.override ?? true,
        },
      });
    },
  };
}

function stripUnsyncableEnvVars(env: Record<string, string>): Record<string, string> {
  return Object.entries(env).reduce(
    (acc, [key, value]) => {
      if (UNSYNCABLE_ENV_VARS.includes(key)) {
        return acc;
      }

      // Strip out any TRIGGER_ prefix env vars
      if (UNSYNCABLE_ENV_VARS_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        return acc;
      }

      acc[key] = value;
      return acc;
    },
    {} as Record<string, string>
  );
}

async function callSyncEnvVarsFn(
  syncEnvVarsFn: SyncEnvVarsFunction | undefined,
  env: Record<string, string>,
  environment: string,
  branch: string | undefined,
  context: BuildContext
): Promise<{ env: Record<string, string>; parentEnv?: Record<string, string> } | undefined> {
  if (syncEnvVarsFn && typeof syncEnvVarsFn === "function") {
    let resolvedEnvVars: { env: Record<string, string>; parentEnv?: Record<string, string> } = {
      env: {},
    };
    let result;

    try {
      result = await syncEnvVarsFn({
        projectRef: context.config.project,
        environment,
        env,
        branch,
      });
    } catch (error) {
      context.logger.warn("Error calling syncEnvVars function", error);
    }

    if (!result) {
      return;
    }

    if (Array.isArray(result)) {
      for (const item of result) {
        if (
          typeof item === "object" &&
          item !== null &&
          "name" in item &&
          "value" in item &&
          typeof item.name === "string" &&
          typeof item.value === "string"
        ) {
          if (item.isParentEnv) {
            if (!resolvedEnvVars.parentEnv) {
              resolvedEnvVars.parentEnv = {};
            }
            resolvedEnvVars.parentEnv[item.name] = item.value;
          } else {
            resolvedEnvVars.env[item.name] = item.value;
          }
        }
      }
    } else if (result) {
      resolvedEnvVars.env = result;
    }

    return resolvedEnvVars;
  }

  return;
}
