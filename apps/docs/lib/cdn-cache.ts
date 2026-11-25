// For per-request routes whose output depends only on the URL and the deployment: the CDN keeps
// them a day and serves a stale copy for a week while it refetches.
export const cdnCacheControl = "public, s-maxage=86400, stale-while-revalidate=604800";
