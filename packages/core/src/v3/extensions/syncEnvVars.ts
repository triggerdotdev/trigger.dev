import { BuildExtension } from "../build/extensions.js";

export type SyncEnvVarsBody = Record<string, string> | Array<{ name: string; value: string }>;

export type SyncEnvVarsResult =
  | SyncEnvVarsBody
  | Promise<void | undefined | SyncEnvVarsBody>
  | void
  | undefined;

export type SyncEnvVarsParams = {
  projectRef: string;
  environment: string;
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

      const result = await callSyncEnvVarsFn(
        fn,
        manifest.deploy.env ?? {},
        manifest.environment,
        context.config.project
      );

      if (!result) {
        return;
      }

      const env = Object.entries(result).reduce(
        (acc, [key, value]) => {
          if (UNSYNCABLE_ENV_VARS.includes(key)) {
            return acc;
          }

          acc[key] = value;
          return acc;
        },
        {} as Record<string, string>
      );

      context.addLayer({
        id: "sync-env-vars",
        deploy: {
          env,
          override: options?.override ?? true,
        },
      });
    },
  };
}

async function callSyncEnvVarsFn(
  syncEnvVarsFn: SyncEnvVarsFunction | undefined,
  env: Record<string, string>,
  environment: string,
  projectRef: string
): Promise<Record<string, string> | undefined> {
  if (syncEnvVarsFn && typeof syncEnvVarsFn === "function") {
    let resolvedEnvVars: Record<string, string> = {};

    let result = syncEnvVarsFn({
      projectRef,
      environment,
      env,
    });

    if (!result) {
      return;
    }

    result = await result;

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
          resolvedEnvVars[item.name] = item.value;
        }
      }
    } else if (result) {
      resolvedEnvVars = result;
    }

    return resolvedEnvVars;
  }

  return;
}
