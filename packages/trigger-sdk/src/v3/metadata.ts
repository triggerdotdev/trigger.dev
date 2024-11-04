import { DeserializedJson } from "@trigger.dev/core";
import {
  ApiRequestOptions,
  flattenAttributes,
  mergeRequestOptions,
  runMetadata,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

/**
 * Provides access to run metadata operations.
 * @namespace
 * @property {Function} current - Get the current run's metadata.
 * @property {Function} get - Get a specific key from the current run's metadata.
 * @property {Function} set - Set a key in the current run's metadata.
 * @property {Function} del - Delete a key from the current run's metadata.
 * @property {Function} save - Update the entire metadata object for the current run.
 */

export const metadata = {
  current: currentMetadata,
  get: getMetadataKey,
  set: setMetadataKey,
  del: deleteMetadataKey,
  save: saveMetadata,
  replace: replaceMetadata,
  flush: flushMetadata,
  stream: stream,
  append: appendMetadataKey,
  increment: incrementMetadataKey,
  decrement: decrementMetadataKey,
};

export type RunMetadata = Record<string, DeserializedJson>;

/**
 * Returns the metadata of the current run if inside a task run.
 * This function allows you to access the entire metadata object for the current run.
 *
 * @returns {RunMetadata | undefined} The current run's metadata or undefined if not in a run context.
 *
 * @example
 * const currentMetadata = metadata.current();
 * console.log(currentMetadata);
 */
function currentMetadata(): RunMetadata | undefined {
  return runMetadata.current();
}

/**
 * Get a specific key from the metadata of the current run if inside a task run.
 *
 * @param {string} key - The key to retrieve from the metadata.
 * @returns {DeserializedJson | undefined} The value associated with the key, or undefined if not found or not in a run context.
 *
 * @example
 * const user = metadata.get("user");
 * console.log(user.name); // "Eric"
 * console.log(user.id); // "user_1234"
 */
function getMetadataKey(key: string): DeserializedJson | undefined {
  return runMetadata.getKey(key);
}

/**
 * Set a key in the metadata of the current run if inside a task run.
 * This function allows you to update or add a new key-value pair to the run's metadata.
 *
 * @param {string} key - The key to set in the metadata.
 * @param {DeserializedJson} value - The value to associate with the key.
 *
 * @example
 * metadata.set("progress", 0.5);
 */
function setMetadataKey(key: string, value: DeserializedJson) {
  runMetadata.setKey(key, value);
}

/**
 * Delete a key from the metadata of the current run if inside a task run.
 *
 * @param {string} key - The key to delete from the metadata.
 *
 * @example
 * metadata.del("progress");
 */
function deleteMetadataKey(key: string) {
  runMetadata.deleteKey(key);
}

/**
 * Update the entire metadata object for the current run if inside a task run.
 * This function allows you to replace the entire metadata object with a new one.
 *
 * @param {RunMetadata} metadata - The new metadata object to set for the run.
 * @returns {void}
 *
 * @example
 * metadata.replace({ progress: 0.6, user: { name: "Alice", id: "user_5678" } });
 */
function replaceMetadata(metadata: RunMetadata): void {
  runMetadata.update(metadata);
}

/**
 * @deprecated Use `metadata.replace()` instead.
 */
function saveMetadata(metadata: RunMetadata): void {
  runMetadata.update(metadata);
}

function incrementMetadataKey(key: string, value: number) {
  runMetadata.incrementKey(key, value);
}

function decrementMetadataKey(key: string, value: number) {
  runMetadata.decrementKey(key, value);
}

function appendMetadataKey(key: string, value: DeserializedJson) {
  runMetadata.appendKey(key, value);
}

/**
 * Flushes metadata to the Trigger.dev instance
 *
 * @param {ApiRequestOptions} [requestOptions] - Optional request options to customize the API request.
 * @returns {Promise<void>} A promise that resolves when the metadata flush operation is complete.
 */
async function flushMetadata(requestOptions?: ApiRequestOptions): Promise<void> {
  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "metadata.flush()",
      icon: "code-plus",
    },
    requestOptions
  );

  await runMetadata.flush($requestOptions);
}

async function stream<T>(
  key: string,
  value: AsyncIterable<T>,
  signal?: AbortSignal
): Promise<AsyncIterable<T>> {
  return runMetadata.stream(key, value, signal);
}
