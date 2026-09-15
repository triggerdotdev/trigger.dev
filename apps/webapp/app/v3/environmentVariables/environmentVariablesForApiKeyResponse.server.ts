type EnvironmentVariable = {
  key: string;
  value: string;
};

/**
 * Preserve the resolved runtime variables while ensuring an API-key caller
 * only receives the credential it already presented.
 */
export function environmentVariablesForApiKeyResponse(
  variables: EnvironmentVariable[],
  presentedApiKey: string
): Record<string, string> {
  return variables.reduce<Record<string, string>>((acc, variable) => {
    acc[variable.key] = variable.key === "TRIGGER_SECRET_KEY" ? presentedApiKey : variable.value;
    return acc;
  }, {});
}
