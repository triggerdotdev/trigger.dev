import { EnvironmentKeyUnavailableError } from "~/services/environmentEncryption/wrapping.server";

type VariableValueItem = { environmentId: string; key: string };

type VariableValuesReader = {
  getVariableValuesForKeys(
    projectId: string,
    items: VariableValueItem[]
  ): Promise<Map<string, string>>;
};

/**
 * Reads stored values, keyed `${environmentId}:${key}`, without failing the page when an
 * environment's encryption key is unavailable. All the items are read at once; if that fails for
 * a missing key, each environment is read on its own, and the ones that still fail are returned
 * in `unavailableEnvironments` with no values.
 */
export async function getReadableVariableValues(
  repository: VariableValuesReader,
  projectId: string,
  items: VariableValueItem[]
): Promise<{ values: Map<string, string>; unavailableEnvironments: Set<string> }> {
  const unavailableEnvironments = new Set<string>();

  try {
    return {
      values: await repository.getVariableValuesForKeys(projectId, items),
      unavailableEnvironments,
    };
  } catch (error) {
    if (!(error instanceof EnvironmentKeyUnavailableError)) throw error;
  }

  const values = new Map<string, string>();
  const environmentIds = [...new Set(items.map((item) => item.environmentId))];
  const results = await Promise.allSettled(
    environmentIds.map((environmentId) =>
      repository.getVariableValuesForKeys(
        projectId,
        items.filter((item) => item.environmentId === environmentId)
      )
    )
  );
  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") {
      for (const [key, value] of result.value) values.set(key, value);
    } else if (result.reason instanceof EnvironmentKeyUnavailableError) {
      unavailableEnvironments.add(environmentIds[i]!);
    } else throw result.reason;
  }

  return { values, unavailableEnvironments };
}
