import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";

describe("fast-xml-parser aws-sdk entity names", () => {
  it("accepts addEntity(\"#xD\") the way @aws-sdk/xml-builder does", () => {
    const parser = new XMLParser({ htmlEntities: true });
    expect(() => {
      parser.addEntity("#xD", "\r");
      parser.parse("<a>1</a>", true);
    }).not.toThrow();
  });
});
