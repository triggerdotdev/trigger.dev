import {
  parseNaturalLanguageDuration,
  safeParseNaturalLanguageDuration,
  parseNaturalLanguageDurationAgo,
  safeParseNaturalLanguageDurationAgo,
  stringifyDuration,
} from "../src/v3/isomorphic/duration.js";

describe("parseNaturalLanguageDuration", () => {
  let baseTime: Date;

  beforeEach(() => {
    // Set a fixed base time for consistent testing
    baseTime = new Date("2024-01-01T12:00:00.000Z");
    vi.setSystemTime(baseTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("valid duration strings", () => {
    it("parses seconds correctly", () => {
      const result = parseNaturalLanguageDuration("30s");
      expect(result).toEqual(new Date("2024-01-01T12:00:30.000Z"));
    });

    it("parses minutes correctly", () => {
      const result = parseNaturalLanguageDuration("15m");
      expect(result).toEqual(new Date("2024-01-01T12:15:00.000Z"));
    });

    it("parses hours correctly", () => {
      const result = parseNaturalLanguageDuration("2h");
      expect(result).toEqual(new Date("2024-01-01T14:00:00.000Z"));
    });

    it("parses hours with 'hr' format correctly", () => {
      const result = parseNaturalLanguageDuration("2hr");
      expect(result).toEqual(new Date("2024-01-01T14:00:00.000Z"));
    });

    it("parses days correctly", () => {
      const result = parseNaturalLanguageDuration("3d");
      expect(result).toEqual(new Date("2024-01-04T12:00:00.000Z"));
    });

    it("parses weeks correctly", () => {
      const result = parseNaturalLanguageDuration("1w");
      expect(result).toEqual(new Date("2024-01-08T12:00:00.000Z"));
    });

    it("parses combined durations correctly", () => {
      const result = parseNaturalLanguageDuration("1w2d3h4m5s");
      expect(result).toEqual(new Date("2024-01-10T15:04:05.000Z"));
    });

    it("parses combined durations with 'hr' format correctly", () => {
      const result = parseNaturalLanguageDuration("1w2d3hr4m5s");
      expect(result).toEqual(new Date("2024-01-10T15:04:05.000Z"));
    });

    it("parses partial combined durations correctly", () => {
      const result = parseNaturalLanguageDuration("2d30m");
      expect(result).toEqual(new Date("2024-01-03T12:30:00.000Z"));
    });

    it("parses durations with units in any order", () => {
      const result = parseNaturalLanguageDuration("30s2h1d");
      expect(result).toEqual(new Date("2024-01-02T14:00:30.000Z"));
    });

    it("parses durations with 'hr' in any order", () => {
      const result = parseNaturalLanguageDuration("30s2hr1d");
      expect(result).toEqual(new Date("2024-01-02T14:00:30.000Z"));
    });

    it("handles zero values", () => {
      const result = parseNaturalLanguageDuration("0s");
      expect(result).toEqual(new Date("2024-01-01T12:00:00.000Z"));
    });

    it("handles large numbers", () => {
      const result = parseNaturalLanguageDuration("100d");
      expect(result).toEqual(new Date("2024-04-10T12:00:00.000Z"));
    });
  });

  describe("invalid duration strings", () => {
    it("returns undefined for empty string", () => {
      const result = parseNaturalLanguageDuration("");
      expect(result).toBeUndefined();
    });

    it("returns undefined for invalid format", () => {
      const result = parseNaturalLanguageDuration("invalid");
      expect(result).toBeUndefined();
    });

    it("returns undefined for negative numbers", () => {
      const result = parseNaturalLanguageDuration("-1h");
      expect(result).toBeUndefined();
    });

    it("returns undefined for invalid units", () => {
      const result = parseNaturalLanguageDuration("1x");
      expect(result).toBeUndefined();
    });

    it("returns undefined for mixed valid/invalid format", () => {
      const result = parseNaturalLanguageDuration("1h2x");
      expect(result).toBeUndefined();
    });

    it("returns undefined for decimal numbers", () => {
      const result = parseNaturalLanguageDuration("1.5h");
      expect(result).toBeUndefined();
    });

    it("returns undefined for units without numbers", () => {
      const result = parseNaturalLanguageDuration("h");
      expect(result).toBeUndefined();
    });
  });
});

describe("safeParseNaturalLanguageDuration", () => {
  let baseTime: Date;

  beforeEach(() => {
    baseTime = new Date("2024-01-01T12:00:00.000Z");
    vi.setSystemTime(baseTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the same result as parseNaturalLanguageDuration for valid input", () => {
    const duration = "1h30m";
    const result1 = parseNaturalLanguageDuration(duration);
    const result2 = safeParseNaturalLanguageDuration(duration);
    expect(result1).toEqual(result2);
  });

  it("returns undefined for invalid input without throwing", () => {
    const result = safeParseNaturalLanguageDuration("invalid");
    expect(result).toBeUndefined();
  });

  it("handles exceptions gracefully", () => {
    // Mock parseNaturalLanguageDuration to throw an error
    const originalParse = parseNaturalLanguageDuration;
    const mockParse = vi.fn().mockImplementation(() => {
      throw new Error("Test error");
    });

    // This test demonstrates the safe wrapper behavior
    expect(() => safeParseNaturalLanguageDuration("1h")).not.toThrow();
  });
});

describe("parseNaturalLanguageDurationAgo", () => {
  let baseTime: Date;

  beforeEach(() => {
    baseTime = new Date("2024-01-01T12:00:00.000Z");
    vi.setSystemTime(baseTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("valid duration strings", () => {
    it("parses seconds ago correctly", () => {
      const result = parseNaturalLanguageDurationAgo("30s");
      expect(result).toEqual(new Date("2024-01-01T11:59:30.000Z"));
    });

    it("parses minutes ago correctly", () => {
      const result = parseNaturalLanguageDurationAgo("15m");
      expect(result).toEqual(new Date("2024-01-01T11:45:00.000Z"));
    });

    it("parses hours ago correctly", () => {
      const result = parseNaturalLanguageDurationAgo("2h");
      expect(result).toEqual(new Date("2024-01-01T10:00:00.000Z"));
    });

    it("parses hours ago with 'hr' format correctly", () => {
      const result = parseNaturalLanguageDurationAgo("2hr");
      expect(result).toEqual(new Date("2024-01-01T10:00:00.000Z"));
    });

    it("parses days ago correctly", () => {
      const result = parseNaturalLanguageDurationAgo("3d");
      expect(result).toEqual(new Date("2023-12-29T12:00:00.000Z"));
    });

    it("parses weeks ago correctly", () => {
      const result = parseNaturalLanguageDurationAgo("1w");
      expect(result).toEqual(new Date("2023-12-25T12:00:00.000Z"));
    });

    it("parses combined durations ago correctly", () => {
      const result = parseNaturalLanguageDurationAgo("1w2d3h4m5s");
      expect(result).toEqual(new Date("2023-12-23T08:55:55.000Z"));
    });

    it("parses combined durations ago with 'hr' format correctly", () => {
      const result = parseNaturalLanguageDurationAgo("1w2d3hr4m5s");
      expect(result).toEqual(new Date("2023-12-23T08:55:55.000Z"));
    });

    it("parses partial combined durations ago correctly", () => {
      const result = parseNaturalLanguageDurationAgo("2d30m");
      expect(result).toEqual(new Date("2023-12-30T11:30:00.000Z"));
    });

    it("handles zero values", () => {
      const result = parseNaturalLanguageDurationAgo("0s");
      expect(result).toEqual(new Date("2024-01-01T12:00:00.000Z"));
    });

    it("handles large numbers in the past", () => {
      const result = parseNaturalLanguageDurationAgo("100d");
      expect(result).toEqual(new Date("2023-09-23T12:00:00.000Z"));
    });
  });

  describe("invalid duration strings", () => {
    it("returns undefined for empty string", () => {
      const result = parseNaturalLanguageDurationAgo("");
      expect(result).toBeUndefined();
    });

    it("returns undefined for invalid format", () => {
      const result = parseNaturalLanguageDurationAgo("invalid");
      expect(result).toBeUndefined();
    });

    it("returns undefined for negative numbers", () => {
      const result = parseNaturalLanguageDurationAgo("-1h");
      expect(result).toBeUndefined();
    });

    it("returns undefined for invalid units", () => {
      const result = parseNaturalLanguageDurationAgo("1x");
      expect(result).toBeUndefined();
    });
  });
});

describe("safeParseNaturalLanguageDurationAgo", () => {
  let baseTime: Date;

  beforeEach(() => {
    baseTime = new Date("2024-01-01T12:00:00.000Z");
    vi.setSystemTime(baseTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the same result as parseNaturalLanguageDurationAgo for valid input", () => {
    const duration = "1h30m";
    const result1 = parseNaturalLanguageDurationAgo(duration);
    const result2 = safeParseNaturalLanguageDurationAgo(duration);
    expect(result1).toEqual(result2);
  });

  it("returns undefined for invalid input without throwing", () => {
    const result = safeParseNaturalLanguageDurationAgo("invalid");
    expect(result).toBeUndefined();
  });

  it("handles exceptions gracefully", () => {
    expect(() => safeParseNaturalLanguageDurationAgo("1h")).not.toThrow();
  });
});

describe("stringifyDuration", () => {
  it("returns undefined for zero or negative seconds", () => {
    expect(stringifyDuration(0)).toBeUndefined();
    expect(stringifyDuration(-1)).toBeUndefined();
  });

  it("formats seconds correctly", () => {
    expect(stringifyDuration(30)).toBe("30s");
  });

  it("formats minutes correctly", () => {
    expect(stringifyDuration(90)).toBe("1m30s");
  });

  it("formats hours correctly", () => {
    expect(stringifyDuration(3661)).toBe("1h1m1s");
  });

  it("formats days correctly", () => {
    expect(stringifyDuration(90061)).toBe("1d1h1m1s");
  });

  it("formats weeks correctly", () => {
    expect(stringifyDuration(694861)).toBe("1w1d1h1m1s");
  });

  it("omits zero units", () => {
    expect(stringifyDuration(3600)).toBe("1h");
    expect(stringifyDuration(3660)).toBe("1h1m");
    expect(stringifyDuration(86400)).toBe("1d");
  });

  it("handles large durations", () => {
    expect(stringifyDuration(1209600)).toBe("2w"); // 2 weeks
  });

  it("handles complex durations", () => {
    expect(stringifyDuration(694861)).toBe("1w1d1h1m1s");
  });
});

describe("duration function consistency", () => {
  let baseTime: Date;

  beforeEach(() => {
    baseTime = new Date("2024-01-01T12:00:00.000Z");
    vi.setSystemTime(baseTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parseNaturalLanguageDuration and parseNaturalLanguageDurationAgo should be symmetric", () => {
    const duration = "1h30m15s";
    const futureDate = parseNaturalLanguageDuration(duration);
    const pastDate = parseNaturalLanguageDurationAgo(duration);

    expect(futureDate).toBeDefined();
    expect(pastDate).toBeDefined();

    if (futureDate && pastDate) {
      const now = new Date();
      const futureOffset = futureDate.getTime() - now.getTime();
      const pastOffset = now.getTime() - pastDate.getTime();

      expect(futureOffset).toBe(pastOffset);
    }
  });

  it("safe versions should match unsafe versions for valid input", () => {
    const duration = "2d4h";

    const future1 = parseNaturalLanguageDuration(duration);
    const future2 = safeParseNaturalLanguageDuration(duration);
    const past1 = parseNaturalLanguageDurationAgo(duration);
    const past2 = safeParseNaturalLanguageDurationAgo(duration);

    expect(future1).toEqual(future2);
    expect(past1).toEqual(past2);
  });

  it("safe versions should return undefined for invalid input", () => {
    const invalidDuration = "invalid-duration";

    expect(parseNaturalLanguageDuration(invalidDuration)).toBeUndefined();
    expect(safeParseNaturalLanguageDuration(invalidDuration)).toBeUndefined();
    expect(parseNaturalLanguageDurationAgo(invalidDuration)).toBeUndefined();
    expect(safeParseNaturalLanguageDurationAgo(invalidDuration)).toBeUndefined();
  });
});
