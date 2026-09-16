import { z } from "zod";
import parseDuration from "parse-duration";

const DurationString = z.string().refine(
  (val) => {
    const ms = parseDuration(val);
    return ms !== null && ms > 0;
  },
  { error: (issue) => `Invalid or non-positive duration string: "${issue.input}"` }
);

const BracketSchema = z.object({
  max: z.union([z.literal("Infinity"), DurationString]),
  granularity: DurationString,
});

const BracketsSchema = z
  .array(BracketSchema)
  .min(1, "TimeGranularity requires at least one bracket");

export type TimeGranularityBracket = z.input<typeof BracketSchema>;

type ParsedBracket = {
  maxMs: number;
  granularityMs: number;
};

function requireParsedDuration(input: string): number {
  const ms = parseDuration(input);
  if (ms === null || ms <= 0) {
    throw new Error(`Duration must be strictly positive, got "${input}" (${ms}ms)`);
  }
  return ms;
}

export class TimeGranularity {
  private readonly parsed: ParsedBracket[];

  constructor(brackets: TimeGranularityBracket[]) {
    const validated = BracketsSchema.parse(brackets);

    this.parsed = validated.map((b) => ({
      maxMs: b.max === "Infinity" ? Infinity : requireParsedDuration(b.max),
      granularityMs: requireParsedDuration(b.granularity),
    }));
  }

  getTimeGranularityMs(from: Date, to: Date): number {
    if (from.getTime() > to.getTime()) {
      return this.parsed[this.parsed.length - 1].granularityMs;
    }

    const rangeMs = to.getTime() - from.getTime();
    for (const bracket of this.parsed) {
      if (rangeMs <= bracket.maxMs) {
        return bracket.granularityMs;
      }
    }
    return this.parsed[this.parsed.length - 1].granularityMs;
  }
}

const MAX_CHART_BUCKETS = 10_000;

/**
 * Rejects user-supplied chart ranges before they reach a query or a bucket
 * loop: non-finite or inverted dates, or a span that would generate an
 * unbounded number of buckets at the chosen granularity.
 */
export function isBoundedChartRange(from: Date, to: Date, granularityMs: number): boolean {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return (
    Number.isFinite(fromMs) &&
    Number.isFinite(toMs) &&
    fromMs <= toMs &&
    (toMs - fromMs) / granularityMs <= MAX_CHART_BUCKETS
  );
}
