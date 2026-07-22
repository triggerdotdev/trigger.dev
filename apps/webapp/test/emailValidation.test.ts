import { describe, expect, it } from "vitest";
import { emailSchema, MAX_EMAIL_LENGTH } from "~/utils/emailValidation";

function emailWithLength(length: number) {
  const domain = "@example.com";
  return `${"a".repeat(length - domain.length)}${domain}`;
}

describe("emailSchema", () => {
  it("accepts an email at the maximum length", () => {
    expect(emailSchema.safeParse(emailWithLength(MAX_EMAIL_LENGTH)).success).toBe(true);
  });

  it("rejects an email over the maximum length", () => {
    const result = emailSchema.safeParse(emailWithLength(MAX_EMAIL_LENGTH + 1));

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected an overlong email to be rejected");
    }

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        message: `Email must be ${MAX_EMAIL_LENGTH} characters or fewer`,
      })
    );
  });
});
