import { describe, expect, it } from "vitest";
import { splitTag } from "~/components/runs/v3/RunTag";

describe("splitTag", () => {
  it("should return the original string when no separator is found", () => {
    expect(splitTag("simpletag")).toBe("simpletag");
    expect(splitTag("tag-with-dashes")).toBe("tag-with-dashes");
    expect(splitTag("tag.with.dots")).toBe("tag.with.dots");
  });

  it("should return the original string when key is longer than 12 characters", () => {
    expect(splitTag("verylongcategory:prod")).toBe("verylongcategory:prod");
    expect(splitTag("verylongcategory_prod")).toBe("verylongcategory_prod");
  });

  it("should split tag with underscore separator", () => {
    expect(splitTag("env_prod")).toEqual({ key: "env", value: "prod" });
    expect(splitTag("category_batch")).toEqual({ key: "category", value: "batch" });
  });

  it("should split tag with colon separator", () => {
    expect(splitTag("env:prod")).toEqual({ key: "env", value: "prod" });
    expect(splitTag("category:batch")).toEqual({ key: "category", value: "batch" });
    expect(splitTag("customer:test_customer")).toEqual({ key: "customer", value: "test_customer" });
  });

  it("should handle mixed delimiters", () => {
    expect(splitTag("category:batch_job")).toEqual({ key: "category", value: "batch_job" });
    expect(splitTag("status_error:500")).toEqual({ key: "status", value: "error:500" });
  });

  it("should preserve common ID formats", () => {
    expect(splitTag("job_123_456")).toBe("job_123_456");
    expect(splitTag("run:123:456")).toBe("run:123:456");
    expect(splitTag("task123_job_456")).toBe("task123_job_456");
  });

  it("should return original string when multiple separators are found", () => {
    expect(splitTag("env:prod:test")).toBe("env:prod:test");
    expect(splitTag("env_prod_test")).toBe("env_prod_test");
  });

  it("should handle edge case with exactly 12 character key", () => {
    expect(splitTag("abcdefghijkl:value")).toEqual({ key: "abcdefghijkl", value: "value" });
    expect(splitTag("exactlytwelv_chars")).toEqual({ key: "exactlytwelv", value: "chars" });
  });

  it("should handle empty values", () => {
    expect(splitTag("empty:")).toEqual({ key: "empty", value: "" });
    expect(splitTag("nothing_")).toEqual({ key: "nothing", value: "" });
  });

  it("should handle special characters in values", () => {
    expect(splitTag("region:us-west-2")).toEqual({ key: "region", value: "us-west-2" });
    expect(splitTag("query:SELECT * FROM users")).toEqual({ key: "query", value: "SELECT * FROM users" });
    expect(splitTag("path:/api/v1/users")).toEqual({ key: "path", value: "/api/v1/users" });
  });

  it("should handle values containing numbers and special formats", () => {
    expect(splitTag("uuid:123e4567-e89b-12d3-a456-426614174000")).toEqual({ 
      key: "uuid", 
      value: "123e4567-e89b-12d3-a456-426614174000" 
    });
    expect(splitTag("ip_192.168.1.1")).toEqual({ key: "ip", value: "192.168.1.1" });
    expect(splitTag("date:2023-04-01T12:00:00Z")).toEqual({ key: "date", value: "2023-04-01T12:00:00Z" });
  });

  it("should handle keys with numbers", () => {
    expect(splitTag("env2:staging")).toEqual({ key: "env2", value: "staging" });
    expect(splitTag("v1_endpoint")).toEqual({ key: "v1", value: "endpoint" });
  });

  it("should handle particularly complex mixed cases", () => {
    expect(splitTag("env:prod_us-west-2_replica")).toEqual({ key: "env", value: "prod_us-west-2_replica" });
    expect(splitTag("status_error:connection:timeout")).toEqual({ key: "status", value: "error:connection:timeout" });
  });
}); 