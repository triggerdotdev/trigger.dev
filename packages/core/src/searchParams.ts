export function urlWithSearchParams(
  url: string,
  params: Record<string, string | number | boolean> | undefined
) {
  if (!params) {
    return url;
  }

  const urlObj = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      urlObj.searchParams.append(key, String(value));
    }
  }
  return urlObj.toString();
}
