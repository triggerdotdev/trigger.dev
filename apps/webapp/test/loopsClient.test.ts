import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LoopsClient } from "../app/services/loops.server";

// No-op logger for tests
const noopLogger = {
  info: () => {},
  error: () => {},
};

describe("LoopsClient", () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("deleteContact", () => {
    it("should return true on successful deletion", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, message: "Contact deleted." }),
      });

      const client = new LoopsClient("test-api-key", noopLogger);
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.loops.so/api/v1/contacts/delete",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-api-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email: "test@example.com" }),
        }
      );
    });

    it("should return true when contact not found (already deleted)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: false, message: "Contact not found." }),
      });

      const client = new LoopsClient("test-api-key", noopLogger);
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(true);
    });

    it("should return true when API returns 404 (contact already deleted)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const client = new LoopsClient("test-api-key", noopLogger);
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(true);
    });

    it("should return false on API error (500)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const client = new LoopsClient("test-api-key", noopLogger);
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(false);
    });

    it("should return false on unauthorized (401)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const client = new LoopsClient("test-api-key", noopLogger);
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(false);
    });

    it("should return false on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const client = new LoopsClient("test-api-key", noopLogger);
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(false);
    });

    it("should return false on other failure responses", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: false, message: "Some other error" }),
      });

      const client = new LoopsClient("test-api-key", noopLogger);
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(false);
    });
  });
});
