export type ESMRequireError = {
  type: "esm-require-error";
  moduleName: string;
};

export type DeployError = ESMRequireError | string;

export function parseDeployErrorStack(error: string): DeployError {
  const isErrRequireEsm = error.includes("ERR_REQUIRE_ESM");

  let moduleName = null;

  if (isErrRequireEsm) {
    // Regular expression to match the module path
    const moduleRegex = /\/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)/;
    const match = moduleRegex.exec(error);
    if (match) {
      moduleName = match[1] as string; // Capture the module name

      return {
        type: "esm-require-error",
        moduleName,
      };
    }
  }

  return error;
}
