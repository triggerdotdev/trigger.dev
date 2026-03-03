import parseDuration from "parse-duration";

export type TimeGranularityBracket = {
  max: string;
  granularity: string;
};

type ParsedBracket = {
  maxMs: number;
  granularityMs: number;
};

export class TimeGranularity {
  private readonly parsed: ParsedBracket[];

  constructor(brackets: TimeGranularityBracket[]) {
    if (brackets.length === 0) {
      throw new Error("TimeGranularity requires at least one bracket");
    }

    this.parsed = brackets.map((b) => ({
      maxMs: parseDuration(b.max) ?? Infinity,
      granularityMs: parseDuration(b.granularity)!,
    }));
  }

  getTimeGranularityMs(from: Date, to: Date): number {
    const rangeMs = to.getTime() - from.getTime();
    for (const bracket of this.parsed) {
      if (rangeMs <= bracket.maxMs) {
        return bracket.granularityMs;
      }
    }
    return this.parsed[this.parsed.length - 1].granularityMs;
  }
}
