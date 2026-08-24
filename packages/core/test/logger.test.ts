import { Logger, redact } from "../src/logger.js";
import { SimpleStructuredLogger } from "../src/v3/utils/structuredLogger.js";

function captureLogLine(fn: () => void): Record<string, any> {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});

  try {
    fn();
    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0] as [string];
    return JSON.parse(line);
  } finally {
    spy.mockRestore();
  }
}

function captureErrorLogLine(fn: () => void): Record<string, any> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    fn();
    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0] as [string];
    return JSON.parse(line);
  } finally {
    spy.mockRestore();
  }
}

describe("Logger redaction", () => {
  it("redacts default deny-listed keys without any caller-supplied filteredKeys", () => {
    const logger = new Logger("test", "info");

    const line = captureLogLine(() =>
      logger.info("run started", {
        payload: { secret: "value" },
        apiKey: "tr_prod_should_not_appear",
        harmless: "keep me",
      })
    );

    expect(line.payload).toMatch(/^\[filtered/);
    expect(line.apiKey).toMatch(/^\[filtered/);
    expect(line.harmless).toBe("keep me");
    expect(JSON.stringify(line)).not.toContain("tr_prod_should_not_appear");
  });

  it("matches deny-listed keys case-insensitively", () => {
    const logger = new Logger("test", "info");

    const line = captureLogLine(() =>
      logger.info("case check", {
        ApiKey: "tr_prod_secret",
        AUTHORIZATION: "Bearer abc123",
      })
    );

    expect(line.ApiKey).toMatch(/^\[filtered/);
    expect(line.AUTHORIZATION).toMatch(/^\[filtered/);
  });

  it("recurses into nested objects and arrays", () => {
    const logger = new Logger("test", "info");

    const line = captureLogLine(() =>
      logger.info("nested check", {
        run: {
          items: [{ metadata: { token: "abc" } }, { metadata: { token: "def" } }],
        },
      })
    );

    for (const item of line.run.items) {
      expect(item.metadata).toMatch(/^\[filtered/);
    }
  });

  it("still honors caller-supplied filteredKeys in addition to the defaults", () => {
    const logger = new Logger("test", "info", ["connectionString"]);

    const line = captureLogLine(() =>
      logger.info("db check", { connectionString: "postgres://user:pass@host/db" })
    );

    expect(line.connectionString).toMatch(/^\[filtered/);
  });

  it("filters every argument, not only a single object argument", () => {
    const logger = new Logger("test", "info");

    const line = captureLogLine(() =>
      logger.info("two args", { first: "ok" }, { apiKey: "tr_prod_secret_value" })
    );

    expect(JSON.stringify(line)).not.toContain("tr_prod_secret_value");
  });

  it("redacts values that contain a secret even under a non-denied key", () => {
    const logger = new Logger("test", "info");

    const line = captureLogLine(() =>
      logger.info("value pattern check", {
        someRandomField: "request failed with tr_live_abcdef123456",
        anotherField: "authorization used Bearer some.jwt.value",
        normalField: "just some text",
      })
    );

    expect(line.someRandomField).toMatch(/^\[filtered/);
    expect(line.anotherField).toMatch(/^\[filtered/);
    expect(line.normalField).toBe("just some text");
  });

  it("redacts a structured message before assigning it to $message", () => {
    const logger = new Logger("test", "info");

    const line = captureLogLine(() =>
      logger.info("structured message check", {
        message: "request failed with Bearer secret.jwt.value",
      })
    );

    expect(line.$message).toMatch(/^\[filtered/);
    expect(JSON.stringify(line)).not.toContain("secret.jwt.value");
  });

  it("truncates strings longer than the per-field cap", () => {
    const logger = new Logger("test", "info");
    const longValue = "a".repeat(20_000);

    const line = captureLogLine(() => logger.info("truncation check", { longValue }));

    expect(line.longValue.length).toBeLessThan(longValue.length);
    expect(line.longValue).toContain("[truncated");
  });

  it("truncates arrays longer than the max array length", () => {
    const logger = new Logger("test", "info");
    const bigArray = Array.from({ length: 500 }, (_, i) => i);

    const line = captureLogLine(() => logger.info("array truncation check", { bigArray }));

    expect(line.bigArray.length).toBeLessThan(bigArray.length);
    expect(line.bigArray[line.bigArray.length - 1]).toContain("truncated");
  });

  it("runs error metadata through the same key-based redaction as everything else", () => {
    const logger = new Logger("test", "info");

    const error = new Error("a plain failure message") as Error & { metadata?: unknown };
    error.metadata = { apiKey: "tr_prod_should_not_leak" };

    const line = captureErrorLogLine(() => logger.error("boom", { error }));

    expect(line.error.message).toBe("a plain failure message");
    expect(line.error.metadata.apiKey).toMatch(/^\[filtered/);
    expect(JSON.stringify(line)).not.toContain("tr_prod_should_not_leak");
  });

  it("redacts an error message whose entire value is a bare secret", () => {
    const logger = new Logger("test", "info");

    const error = new Error("tr_prod_secret_value_leaked");

    const line = captureErrorLogLine(() => logger.error("boom", { error }));

    expect(line.error.message).toMatch(/^\[filtered/);
  });
});

describe("SimpleStructuredLogger redaction", () => {
  it("redacts fields and arguments with the default deny-list", () => {
    const logger = new SimpleStructuredLogger("test");

    const line = captureLogLine(() =>
      logger.child({ headers: { authorization: "Bearer should-not-appear" } }).info("run started", {
        payload: { secret: "value" },
        apiKey: "tr_prod_should_not_appear",
        harmless: "keep me",
      })
    );

    expect(line.headers).toMatch(/^\[filtered/);
    expect(line.payload).toMatch(/^\[filtered/);
    expect(line.apiKey).toMatch(/^\[filtered/);
    expect(line.harmless).toBe("keep me");
    expect(JSON.stringify(line)).not.toContain("should-not-appear");
  });
});

describe("redact()", () => {
  it("applies the same default deny-list and truncation as the Logger", () => {
    const result = redact({
      apiKey: "tr_prod_secret_value",
      email: "user@example.com",
      keep: "this stays",
    }) as Record<string, unknown>;

    expect(result.apiKey).toMatch(/^\[filtered/);
    expect(result.email).toMatch(/^\[filtered/);
    expect(result.keep).toBe("this stays");
  });

  it("merges in caller-supplied filteredKeys", () => {
    const result = redact({ connectionString: "postgres://user:pass@host/db" }, [
      "connectionString",
    ]) as Record<string, unknown>;

    expect(result.connectionString).toMatch(/^\[filtered/);
  });
});
