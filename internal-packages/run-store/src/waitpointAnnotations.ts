/**
 * Internal, sticky discovery marker. Producers hold the run's lifecycle lock while marking it;
 * attempt annotation stamps use that same lock, so a stamp cannot overwrite a concurrent mark.
 * This is deliberately separate from the SDK-consumed RunAnnotations schema.
 */
export function hasStoreWaitpoints(annotations: unknown): boolean {
  return (
    typeof annotations === "object" &&
    annotations !== null &&
    !Array.isArray(annotations) &&
    (annotations as Record<string, unknown>).waitpointsOnStore === true
  );
}

/** Internal batch identity, never part of the API options contract. */
export function batchStoreWaitpointId(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
  const id = (options as Record<string, unknown>).waitpointStoreId;
  return typeof id === "string" ? id : undefined;
}
