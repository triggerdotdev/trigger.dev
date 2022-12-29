export function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};

  headers.forEach((value, key) => {
    normalizedHeaders[key.toLowerCase()] = value;
  });

  return normalizedHeaders;
}
