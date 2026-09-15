/**
 * Percent-encode a task id for use as a single URL path segment. `encodeURIComponent` throws a
 * `URIError` for a string that cannot be represented in a URL (an unpaired UTF-16 surrogate);
 * rethrow it as a clear, actionable error naming the id instead of a cryptic "URI malformed".
 */
export function encodeTaskIdForPath(taskId: string): string {
  try {
    return encodeURIComponent(taskId);
  } catch (error) {
    if (error instanceof URIError) {
      throw new Error(
        `Invalid task id ${JSON.stringify(
          taskId
        )}: it contains characters that cannot be encoded into a URL (for example an unpaired surrogate). Rename the task to use valid characters.`
      );
    }

    throw error;
  }
}
