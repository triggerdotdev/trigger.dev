import type { ShouldRevalidateFunctionArgs } from "@remix-run/react";

/** The search param detail pages keep their selected tab in (see `useDetailTab`). */
const TAB_SEARCH_PARAM = "tab";

function withoutTab(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(TAB_SEARCH_PARAM);
  params.sort();
  return params.toString();
}

/**
 * True when a navigation only switches a detail page's tab: same path, no form submission, and
 * `?tab=` is the only search param that changed. Loaders that don't read `tab` (the layouts above
 * a detail page, and detail pages that load every tab up front) skip revalidating, so a tab
 * switch makes no request. Explicit `revalidate()` calls keep the URL and still revalidate.
 */
export function onlyDetailTabChanged({
  currentUrl,
  nextUrl,
  formMethod,
}: Pick<ShouldRevalidateFunctionArgs, "currentUrl" | "nextUrl" | "formMethod">): boolean {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) return false;
  if (currentUrl.search === nextUrl.search) return false;
  const tabBefore = currentUrl.searchParams.get(TAB_SEARCH_PARAM);
  const tabAfter = nextUrl.searchParams.get(TAB_SEARCH_PARAM);
  return tabBefore !== tabAfter && withoutTab(currentUrl.search) === withoutTab(nextUrl.search);
}
