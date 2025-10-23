import { DeserializedJson } from "@trigger.dev/core";
import {
  ApiRequestOptions,
  mergeRequestOptions,
  runMetadata,
  type RunMetadataUpdater,
  type AsyncIterableStream,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";
import { streams } from "./streams.js";

const parentMetadataUpdater: RunMetadataUpdater = runMetadata.parent;
const rootMetadataUpdater: RunMetadataUpdater = runMetadata.root;

/**
 * Provides access to run metadata operations.
 * @namespace
 * @property {Function} current - Get the current run's metadata.
 * @property {Function} get - Get a specific key from the current run's metadata.
 * @property {Function} set - Set a key in the current run's metadata.
 * @property {Function} del - Delete a key from the current run's metadata.
 * @property {Function} save - Update the entire metadata object for the current run.
 */

const metadataUpdater = {
  set: setMetadataKey,
  del: deleteMetadataKey,
  append: appendMetadataKey,
  remove: removeMetadataKey,
  increment: incrementMetadataKey,
  decrement: decrementMetadataKey,
  flush: flushMetadata,
};

export const metadata = {
  current: currentMetadata,
  get: getMetadataKey,
  save: saveMetadata,
  replace: replaceMetadata,
  stream: stream,
  fetchStream: fetchStream,
  parent: parentMetadataUpdater,
  root: rootMetadataUpdater,
  refresh: refreshMetadata,
  ...metadataUpdater,
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
  runMetadata.set(key, value);

  return metadataUpdater;
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
  runMetadata.del(key);
  return metadataUpdater;
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
function replaceMetadata(metadata: RunMetadata) {
  runMetadata.update(metadata);
}

/**
 * @deprecated Use `metadata.replace()` instead.
 */
function saveMetadata(metadata: RunMetadata) {
  runMetadata.update(metadata);
}

/**
 * Increments a numeric value in the metadata of the current run by the specified amount.
 * This function allows you to atomically increment a numeric metadata value.
 *
 * @param {string} key - The key of the numeric value to increment.
 * @param {number} value - The amount to increment the value by.
 *
 * @example
 * metadata.increment("counter", 1); // Increments counter by 1
 * metadata.increment("score", 10); // Increments score by 10
 */
function incrementMetadataKey(key: string, value: number = 1) {
  runMetadata.increment(key, value);
  return metadataUpdater;
}

/**
 * Decrements a numeric value in the metadata of the current run by the specified amount.
 * This function allows you to atomically decrement a numeric metadata value.
 *
 * @param {string} key - The key of the numeric value to decrement.
 * @param {number} value - The amount to decrement the value by.
 *
 * @example
 * metadata.decrement("counter", 1); // Decrements counter by 1
 * metadata.decrement("score", 5); // Decrements score by 5
 */
function decrementMetadataKey(key: string, value: number = 1) {
  runMetadata.decrement(key, value);
  return metadataUpdater;
}

/**
 * Appends a value to an array in the metadata of the current run.
 * If the key doesn't exist, it creates a new array with the value.
 * If the key exists but isn't an array, it converts the existing value to an array.
 *
 * @param {string} key - The key of the array in metadata.
 * @param {DeserializedJson} value - The value to append to the array.
 *
 * @example
 * metadata.append("logs", "User logged in");
 * metadata.append("events", { type: "click", timestamp: Date.now() });
 */
function appendMetadataKey(key: string, value: DeserializedJson) {
  runMetadata.append(key, value);
  return metadataUpdater;
}

/**
 * Removes a value from an array in the metadata of the current run.
 *
 * @param {string} key - The key of the array in metadata.
 * @param {DeserializedJson} value - The value to remove from the array.
 *
 * @example
 *
 * metadata.remove("logs", "User logged in");
 * metadata.remove("events", { type: "click", timestamp: Date.now() });
 */
function removeMetadataKey(key: string, value: DeserializedJson) {
  runMetadata.remove(key, value);
  return metadataUpdater;
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

/**
 * Refreshes metadata from the Trigger.dev instance
 *
 * @param {ApiRequestOptions} [requestOptions] - Optional request options to customize the API request.
 * @returns {Promise<void>} A promise that resolves when the metadata refresh operation is complete.
 */
async function refreshMetadata(requestOptions?: ApiRequestOptions): Promise<void> {
  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "metadata.refresh()",
      icon: "code-plus",
    },
    requestOptions
  );

  await runMetadata.refresh($requestOptions);
}

/**
 * @deprecated Use `streams.append()` instead.
 */
async function stream<T>(
  key: string,
  value: AsyncIterable<T> | ReadableStream<T>,
  signal?: AbortSignal
): Promise<AsyncIterable<T>> {
  const streamInstance = await streams.append(key, value, {
    signal,
  });

  return streamInstance.stream;
}

async function fetchStream<T>(key: string, signal?: AbortSignal): Promise<AsyncIterableStream<T>> {
  return runMetadata.fetchStream<T>(key, signal);
}
