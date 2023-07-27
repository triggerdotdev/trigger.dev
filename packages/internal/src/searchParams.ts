export function urlWithSearchParams(
  url: string,
  params: Record<string, string | number | boolean> | undefined
) {
  if (!params) {
    return url;
  }

  const urlObj = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    urlObj.searchParams.append(key, String(value));
  }
  return urlObj.toString();
}
