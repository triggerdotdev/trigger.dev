import { z } from "zod";
import parseDuration from "parse-duration";

const DurationString = z
  .string()
  .refine(
    (val) => parseDuration(val) !== null,
    (val) => ({ message: `Invalid duration string: "${val}"` })
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
  if (ms === null) {
    throw new Error(`Failed to parse duration string: "${input}"`);
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
