import { BloomFilter } from "../src/bloom.js";

describe("BloomFilter", () => {
  it("should be able to correct test for inclusion in the set", () => {
    const filter = new BloomFilter(1000);

    filter.add("hello");
    filter.add("world");

    expect(filter.test("hello")).toBe(true);
    expect(filter.test("world")).toBe(true);
    expect(filter.test("foo")).toBe(false);
  });

  it("should be able to serialize and deserialize", () => {
    const filter = new BloomFilter(1000);

    filter.add("hello");
    filter.add("world");

    const serialized = filter.serialize();
    const deserialized = BloomFilter.deserialize(serialized, 1000);

    expect(deserialized.test("hello")).toBe(true);
    expect(deserialized.test("world")).toBe(true);
    expect(deserialized.test("foo")).toBe(false);
  });
});
