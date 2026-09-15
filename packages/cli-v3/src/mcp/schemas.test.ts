import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as schemas from "./schemas.js";

// A tools/list call serializes every tool's input schema to JSON Schema in one batch,
// so one unserializable type fails the whole listing and the server looks like it has
// no tools at all. Zod 4 throws on types it cannot represent (Date, bigint, symbol),
// where Zod 3 silently approximated them, so pin that every schema stays serializable.
const schemaEntries = Object.entries(schemas).filter(
  (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType
);

describe("MCP schemas", () => {
  it("exports schemas to check", () => {
    expect(schemaEntries.length).toBeGreaterThan(0);
  });

  it.each(schemaEntries)("%s serializes to JSON Schema", (_name, schema) => {
    expect(() => z.toJSONSchema(schema)).not.toThrow();
  });

  it("keeps the trigger_task delay representable as a date-time string", () => {
    const schema = z.toJSONSchema(schemas.TriggerTaskInput) as any;
    const delay = schema.properties.options.properties.delay;

    expect(delay.anyOf).toContainEqual(expect.objectContaining({ format: "date-time" }));
  });
});
