const EMPTY_OBJECT =
  /^Failed to download range from object store: (Requested )?Range Not Satisfiable$/;

/** A range read of a zero-byte object, as the fetch client or the AWS SDK client reports it. */
export function isEmptyObjectError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return EMPTY_OBJECT.test(error.message) || error.name === "InvalidRange" || status === 416;
}
