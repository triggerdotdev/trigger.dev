import { TaskRunEnvironmentVariablesConfig } from "@trigger.dev/core/v3/schemas";
import { EnvironmentVariablesProcessor, TriggerTaskRequest } from "../types";
import pMap from "p-map";
import { EncryptedSecretValue, encryptSecret } from "~/services/secrets/secretStore.server";

export class DefaultEnvironmentVariablesProcessor implements EnvironmentVariablesProcessor {
  constructor(private readonly encryptionKey: string) {}

  async process(
    request: TriggerTaskRequest
  ): Promise<TaskRunEnvironmentVariablesConfig | undefined> {
    if (!request.body.options?.env) {
      return undefined;
    }

    const { variables, whitelist, blacklist } = request.body.options.env;

    if (!variables && !whitelist && !blacklist) {
      return undefined;
    }

    const encryptedVariables = await pMap(
      Object.entries(request.body.options.env.variables ?? {}),
      async ([key, value]) => {
        return await createSecretVariable(this.encryptionKey, key, value);
      },
      { concurrency: 10 }
    );

    return {
      variables: encryptedVariables.reduce((acc, curr) => {
        acc[curr.key] = {
          encryptor: curr.encryptor,
          value: curr.value,
        };
        return acc;
      }, {} as Record<string, { encryptor: string; value: EncryptedSecretValue }>),
      whitelist,
      blacklist,
      override: true,
    };
  }
}

async function createSecretVariable(encryptionKey: string, key: string, value: string) {
  const encryptedValue = await encryptSecret(encryptionKey, value);

  return {
    key,
    encryptor: "platform",
    value: encryptedValue,
  };
}
