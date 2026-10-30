/** Metric `kind` for a trace-chunk request, read from its own params. */
export function chunkRequestKind(search: {
  start?: string;
  filter?: string;
  insertedAtSince?: number;
}): "first" | "errors" | "tail" | "page" {
  if (search.start) return "first";
  if (search.filter) return "errors";
  if (search.insertedAtSince !== undefined) return "tail";
  return "page";
}

/** Metric `kind` for a session runs request. */
export function runsPageRequestKind(search: {
  run?: string;
  "page[after]"?: unknown;
  reason?: "open" | "focus" | "poll";
}): "deepLink" | "earlier" | "open" | "focus" | "poll" {
  if (search.run) return "deepLink";
  if (search["page[after]"]) return "earlier";
  return search.reason ?? "open";
}
