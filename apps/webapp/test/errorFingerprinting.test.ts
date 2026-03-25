import { describe, it, expect } from "vitest";
import {
  calculateErrorFingerprint,
  normalizeErrorMessage,
  normalizeStackTrace,
} from "~/utils/errorFingerprinting";

describe("normalizeErrorMessage", () => {
  it("should normalize UUIDs", () => {
    const message = "Error processing user 550e8400-e29b-41d4-a716-446655440000";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Error processing user <uuid>");
  });

  it("should normalize run IDs", () => {
    const message = "Failed to execute run_abcd1234xyz";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Failed to execute <run-id>");
  });

  it("should normalize task friendly IDs", () => {
    const message = "Task task_abc12345678 failed";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Task <id> failed");
  });

  it("should normalize numeric IDs (4+ digits)", () => {
    const message = "User 12345 not found";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("User <id> not found");
  });

  it("should not normalize short numbers", () => {
    const message = "Retry attempt 3 of 5";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Retry attempt 3 of 5");
  });

  it("should normalize ISO 8601 timestamps", () => {
    const message = "Event at 2024-03-01T15:30:45Z failed";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Event at <timestamp> failed");
  });

  it("should normalize ISO timestamps with milliseconds", () => {
    const message = "Timeout at 2024-03-01T15:30:45.123Z";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Timeout at <timestamp>");
  });

  it("should normalize Unix timestamps", () => {
    const message = "Created at 1234567890";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Created at <timestamp>");
  });

  it("should normalize Unix timestamps (milliseconds)", () => {
    const message = "Created at 1234567890123";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Created at <timestamp>");
  });

  it("should normalize Unix file paths", () => {
    const message = "Cannot read /home/user/project/file.ts";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Cannot read <path>");
  });

  it("should normalize Windows file paths", () => {
    const message = "Cannot read C:\\Users\\John\\project\\file.ts";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Cannot read <path>");
  });

  it("should normalize email addresses", () => {
    const message = "Email user@example.com already exists";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Email <email> already exists");
  });

  it("should normalize URLs", () => {
    const message = "Failed to fetch https://api.example.com/users/123";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Failed to fetch <url>");
  });

  it("should normalize HTTP URLs", () => {
    const message = "Request to http://localhost:3000/api failed";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Request to <url> failed");
  });

  it("should normalize memory addresses", () => {
    const message = "Segfault at 0x7fff5fbffab0";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Segfault at <addr>");
  });

  it("should normalize long quoted strings", () => {
    const message = 'Error: "this is a very long error message with dynamic content that changes"';
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe('Error: "<string>"');
  });

  it("should handle multiple replacements", () => {
    const message =
      "User 12345 at user@example.com failed to access run_abc123 at 2024-03-01T15:30:45Z";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("User <id> at <email> failed to access <run-id> at <timestamp>");
  });

  it("should return empty string for empty input", () => {
    expect(normalizeErrorMessage("")).toBe("");
  });

  it("should handle messages with no dynamic content", () => {
    const message = "Connection timeout";
    const normalized = normalizeErrorMessage(message);
    expect(normalized).toBe("Connection timeout");
  });

  describe("ordering: specific patterns before generic ones", () => {
    it("ISO timestamp year should not be consumed by numeric ID regex", () => {
      const message = "Deadline was 2025-12-31T23:59:59Z";
      expect(normalizeErrorMessage(message)).toBe("Deadline was <timestamp>");
    });

    it("ISO timestamp without trailing Z should normalize correctly", () => {
      const message = "Started at 2024-01-15T08:00:00";
      expect(normalizeErrorMessage(message)).toBe("Started at <timestamp>");
    });

    it("Unix timestamp (10 digits) should not become <id>", () => {
      const message = "Token expires 1700000000";
      expect(normalizeErrorMessage(message)).toBe("Token expires <timestamp>");
    });

    it("Unix timestamp (13 digits) should not become <id>", () => {
      const message = "Sent at 1700000000000";
      expect(normalizeErrorMessage(message)).toBe("Sent at <timestamp>");
    });

    it("URL path should not be stripped before URL regex runs", () => {
      const message = "Webhook failed for https://hooks.example.com/webhook/abc";
      expect(normalizeErrorMessage(message)).toBe("Webhook failed for <url>");
    });

    it("URL with port and path should normalize to <url>", () => {
      const message = "Cannot reach http://localhost:8080/health/ready";
      expect(normalizeErrorMessage(message)).toBe("Cannot reach <url>");
    });

    it("URL with query string should normalize to <url>", () => {
      const message = "GET https://api.example.com/v2/users?page=1&limit=50 returned 500";
      expect(normalizeErrorMessage(message)).toBe("GET <url> returned 500");
    });

    it("message with both a URL and a timestamp", () => {
      const message =
        "Request to https://api.example.com/data failed at 2025-06-15T10:30:00Z";
      expect(normalizeErrorMessage(message)).toBe(
        "Request to <url> failed at <timestamp>"
      );
    });

    it("message with a URL and a unix timestamp", () => {
      const message = "Callback to https://example.com/hook timed out after 1700000000";
      expect(normalizeErrorMessage(message)).toBe(
        "Callback to <url> timed out after <timestamp>"
      );
    });

    it("path-like string that is NOT a URL should still become <path>", () => {
      const message = "Cannot read /var/log/app/error.log";
      expect(normalizeErrorMessage(message)).toBe("Cannot read <path>");
    });
  });

  describe("fingerprint stability: same error class groups together despite dynamic values", () => {
    it("errors differing only in ISO timestamp should share a fingerprint", () => {
      const e1 = { type: "TimeoutError", message: "Timed out at 2025-01-01T00:00:00Z" };
      const e2 = { type: "TimeoutError", message: "Timed out at 2026-06-15T12:30:00Z" };
      expect(calculateErrorFingerprint(e1)).toBe(calculateErrorFingerprint(e2));
    });

    it("errors differing only in URL path should share a fingerprint", () => {
      const e1 = {
        type: "FetchError",
        message: "Failed to fetch https://api.example.com/users/123",
      };
      const e2 = {
        type: "FetchError",
        message: "Failed to fetch https://api.example.com/orders/456",
      };
      expect(calculateErrorFingerprint(e1)).toBe(calculateErrorFingerprint(e2));
    });

    it("errors differing only in unix timestamp should share a fingerprint", () => {
      const e1 = { type: "ExpiredError", message: "Token expired at 1700000000" };
      const e2 = { type: "ExpiredError", message: "Token expired at 1800000000" };
      expect(calculateErrorFingerprint(e1)).toBe(calculateErrorFingerprint(e2));
    });
  });
});

describe("normalizeStackTrace", () => {
  it("should normalize line and column numbers", () => {
    const stack = `Error: Test error
    at functionName (file.ts:123:45)
    at anotherFunction (other.ts:67:89)`;
    const normalized = normalizeStackTrace(stack);
    expect(normalized).toContain(":_:_");
    expect(normalized).not.toContain(":123:45");
  });

  it("should remove standalone numbers", () => {
    const stack = `Error: Test
    at Object.<anonymous> (/path/to/file.ts:123:45)
    at Module._compile (node:internal/modules/cjs/loader:456:78)`;
    const normalized = normalizeStackTrace(stack);
    expect(normalized).not.toMatch(/\b\d+\b/);
  });

  it("should keep only first 5 frames", () => {
    const stack = `Error: Test
    at frame1 (file1.ts:1:1)
    at frame2 (file2.ts:2:2)
    at frame3 (file3.ts:3:3)
    at frame4 (file4.ts:4:4)
    at frame5 (file5.ts:5:5)
    at frame6 (file6.ts:6:6)
    at frame7 (file7.ts:7:7)`;
    const normalized = normalizeStackTrace(stack);
    const frames = normalized.split("|");
    expect(frames.length).toBeLessThanOrEqual(5);
  });

  it("should remove file paths but keep filenames", () => {
    const stack = `Error: Test
    at functionName (/home/user/project/src/file.ts:123:45)`;
    const normalized = normalizeStackTrace(stack);
    expect(normalized).toContain("file.ts");
    expect(normalized).not.toContain("/home/user/project/src/");
  });

  it("should filter out empty lines", () => {
    const stack = `Error: Test

    at functionName (file.ts:123:45)

    at anotherFunction (other.ts:67:89)`;
    const normalized = normalizeStackTrace(stack);
    const frames = normalized.split("|").filter((f) => f.length > 0);
    expect(frames.length).toBeLessThanOrEqual(3);
  });

  it("should return empty string for empty stack", () => {
    expect(normalizeStackTrace("")).toBe("");
  });

  it("should join frames with pipe delimiter", () => {
    const stack = `Error: Test
    at frame1 (file1.ts:1:1)
    at frame2 (file2.ts:2:2)`;
    const normalized = normalizeStackTrace(stack);
    expect(normalized).toContain("|");
  });
});

describe("calculateErrorFingerprint", () => {
  it("should generate consistent fingerprints for same error", () => {
    const error = {
      type: "DatabaseError",
      message: "Connection timeout",
      stack: "at db.connect (db.ts:123:45)",
    };
    const fp1 = calculateErrorFingerprint(error);
    const fp2 = calculateErrorFingerprint(error);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(16);
  });

  it("should generate same fingerprint for errors with different IDs", () => {
    const error1 = {
      type: "NotFoundError",
      message: "User 12345 not found",
      stack: "at findUser (user.ts:50:10)",
    };
    const error2 = {
      type: "NotFoundError",
      message: "User 67890 not found",
      stack: "at findUser (user.ts:50:10)",
    };
    const fp1 = calculateErrorFingerprint(error1);
    const fp2 = calculateErrorFingerprint(error2);
    expect(fp1).toBe(fp2);
  });

  it("should generate same fingerprint for errors with different UUIDs", () => {
    const error1 = {
      type: "ValidationError",
      message: "Invalid token 550e8400-e29b-41d4-a716-446655440000",
    };
    const error2 = {
      type: "ValidationError",
      message: "Invalid token 123e4567-e89b-12d3-a456-426614174000",
    };
    expect(calculateErrorFingerprint(error1)).toBe(calculateErrorFingerprint(error2));
  });

  it("should generate same fingerprint for errors with different run IDs", () => {
    const error1 = {
      type: "TaskError",
      message: "Failed to execute run_abc123",
    };
    const error2 = {
      type: "TaskError",
      message: "Failed to execute run_xyz789",
    };
    expect(calculateErrorFingerprint(error1)).toBe(calculateErrorFingerprint(error2));
  });

  it("should generate different fingerprints for different error types", () => {
    const error1 = {
      type: "DatabaseError",
      message: "Connection failed",
    };
    const error2 = {
      type: "NetworkError",
      message: "Connection failed",
    };
    expect(calculateErrorFingerprint(error1)).not.toBe(calculateErrorFingerprint(error2));
  });

  it("should generate different fingerprints for different error messages", () => {
    const error1 = {
      type: "Error",
      message: "Connection timeout",
    };
    const error2 = {
      type: "Error",
      message: "Connection refused",
    };
    expect(calculateErrorFingerprint(error1)).not.toBe(calculateErrorFingerprint(error2));
  });

  it("should handle error with name instead of type", () => {
    const error = {
      name: "TypeError",
      message: "Cannot read property 'foo' of undefined",
    };
    const fp = calculateErrorFingerprint(error);
    expect(fp).toBeTruthy();
    expect(fp.length).toBe(16);
  });

  it("should handle error with stacktrace instead of stack", () => {
    const error = {
      type: "Error",
      message: "Test error",
      stacktrace: "at test (file.ts:1:1)",
    };
    const fp = calculateErrorFingerprint(error);
    expect(fp).toBeTruthy();
  });

  it("should return empty string for non-object error", () => {
    expect(calculateErrorFingerprint(null)).toBe("");
    expect(calculateErrorFingerprint(undefined)).toBe("");
    expect(calculateErrorFingerprint("error string")).toBe("");
    expect(calculateErrorFingerprint(123)).toBe("");
  });

  it("should handle errors with no message or stack", () => {
    const error = {
      type: "Error",
    };
    const fp = calculateErrorFingerprint(error);
    expect(fp).toBeTruthy();
    expect(fp.length).toBe(16);
  });

  it("should generate fingerprints using stack trace when available", () => {
    const error1 = {
      type: "Error",
      message: "Test",
      stack: "at funcA (a.ts:1:1)\nat funcB (b.ts:2:2)",
    };
    const error2 = {
      type: "Error",
      message: "Test",
      stack: "at funcX (x.ts:1:1)\nat funcY (y.ts:2:2)",
    };
    expect(calculateErrorFingerprint(error1)).not.toBe(calculateErrorFingerprint(error2));
  });

  it("should normalize line numbers in stack traces for same code location", () => {
    const error1 = {
      type: "Error",
      message: "Test",
      stack: "at func (file.ts:123:45)",
    };
    const error2 = {
      type: "Error",
      message: "Test",
      stack: "at func (file.ts:456:78)",
    };
    expect(calculateErrorFingerprint(error1)).toBe(calculateErrorFingerprint(error2));
  });
});
