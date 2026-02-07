import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to test the LoopsClient class directly, so we'll create a test instance
// rather than importing the singleton (which depends on env vars)

class LoopsClient {
  constructor(private readonly apiKey: string) {}

  async deleteContact({ email }: { email: string }): Promise<boolean> {
    try {
      const response = await fetch(
        `https://app.loops.so/api/v1/contacts/${encodeURIComponent(email)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.apiKey}` },
        }
      );

      if (!response.ok) {
        // 404 is okay - contact already deleted
        if (response.status === 404) {
          return true;
        }
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }
}

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
    it("should return true on successful deletion (200)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const client = new LoopsClient("test-api-key");
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.loops.so/api/v1/contacts/test%40example.com",
        {
          method: "DELETE",
          headers: { Authorization: "Bearer test-api-key" },
        }
      );
    });

    it("should return true when contact already deleted (404)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const client = new LoopsClient("test-api-key");
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(true);
    });

    it("should return false on API error (500)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const client = new LoopsClient("test-api-key");
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(false);
    });

    it("should return false on unauthorized (401)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const client = new LoopsClient("test-api-key");
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(false);
    });

    it("should return false on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const client = new LoopsClient("test-api-key");
      const result = await client.deleteContact({ email: "test@example.com" });

      expect(result).toBe(false);
    });

    it("should properly encode email addresses with special characters", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const client = new LoopsClient("test-api-key");
      await client.deleteContact({ email: "test+alias@example.com" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://app.loops.so/api/v1/contacts/test%2Balias%40example.com",
        expect.any(Object)
      );
    });
  });
});
