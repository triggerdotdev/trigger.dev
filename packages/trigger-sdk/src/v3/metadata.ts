import { DeserializedJson } from "@trigger.dev/core";
import {
  accessoryAttributes,
  ApiRequestOptions,
  flattenAttributes,
  mergeRequestOptions,
  runMetadata,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

export const metadata = {
  current: currentMetadata,
  get: getMetadataKey,
  set: setMetadataKey,
  del: deleteMetadataKey,
  update: updateMetadata,
};

export type RunMetadata = Record<string, DeserializedJson>;

/**
 * Returns the metadata of the current run if inside a task run.
 */
function currentMetadata(): RunMetadata | undefined {
  return runMetadata.current();
}

/**
 * Get a key from the metadata of the current run if inside a task run.
 */
function getMetadataKey(key: string): DeserializedJson | undefined {
  return runMetadata.getKey(key);
}

/**
 * Set a key in the metadata of the current run if inside a task run.
 *
 * @returns The updated metadata.
 */
async function setMetadataKey(
  key: string,
  value: DeserializedJson,
  requestOptions?: ApiRequestOptions
): Promise<RunMetadata> {
  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "metadata.set()",
      icon: "code-plus",
      attributes: {
        ...accessoryAttributes({
          items: [
            {
              text: key,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
        ...flattenAttributes(value, key),
      },
    },
    requestOptions
  );

  return await runMetadata.setKey(key, value, $requestOptions);
}

async function deleteMetadataKey(
  key: string,
  requestOptions?: ApiRequestOptions
): Promise<RunMetadata> {
  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "metadata.del()",
      icon: "code-minus",
      attributes: {
        ...accessoryAttributes({
          items: [
            {
              text: key,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
        key,
      },
    },
    requestOptions
  );

  return await runMetadata.deleteKey(key, $requestOptions);
}

async function updateMetadata(
  metadata: RunMetadata,
  requestOptions?: ApiRequestOptions
): Promise<RunMetadata> {
  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "metadata.update()",
      icon: "code-plus",
      attributes: {
        ...flattenAttributes(metadata),
      },
    },
    requestOptions
  );

  return await runMetadata.update(metadata, $requestOptions);
}
