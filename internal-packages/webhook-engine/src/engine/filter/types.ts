// Evaluation context for a compiled webhook filter. `event` is the parsed body, `headers` are the
// inbound request headers (looked up case-insensitively), `webhook` is the endpoint metadata.
export type FilterContext = {
  event: unknown;
  headers: Record<string, string>;
  webhook: Record<string, unknown>;
};

export type FilterMatch = { match: boolean; reason?: string };

export class FilterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterParseError";
  }
}

// Soft cap, well below the type-level ~200-clause TS2589 wall, so authors get a clean message.
export const MAX_FILTER_CLAUSES = 50;
