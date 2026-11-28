/**
 * Where a URL with no page goes, as on the previous site: a page that differs only in case
 * (/Machines to /machines), else a nav folder's first page in nav order (/tasks to /tasks/overview).
 */
export function fallbackRedirect(
  path: string,
  pageUrls: Iterable<string>,
  navUrls: string[]
): string | undefined {
  const lower = path.toLowerCase();
  for (const url of pageUrls) if (url !== path && url.toLowerCase() === lower) return url;
  return navUrls.find((url) => url.toLowerCase().startsWith(`${lower}/`));
}
