import { stringifyIO, parsePacket } from "./ioSerialization";

describe("IO Serialization", () => {
  it("should serialize and deserialize Blob objects", async () => {
    const blob = new Blob(["Hello, world!"], { type: "text/plain" });
    const serialized = await stringifyIO(blob);
    expect(serialized.dataType).toBe("application/blob");

    const deserialized = await parsePacket(serialized);
    expect(deserialized instanceof Blob).toBe(true);
    const text = await deserialized.text();
    expect(text).toBe("Hello, world!");
  });

  it("should serialize and deserialize JSON objects", async () => {
    const obj = { key: "value" };
    const serialized = await stringifyIO(obj);
    expect(serialized.dataType).toBe("application/super+json");

    const deserialized = await parsePacket(serialized);
    expect(deserialized).toEqual(obj);
  });

  it("should serialize and deserialize strings", async () => {
    const str = "Hello, world!";
    const serialized = await stringifyIO(str);
    expect(serialized.dataType).toBe("text/plain");

    const deserialized = await parsePacket(serialized);
    expect(deserialized).toBe(str);
  });
});
