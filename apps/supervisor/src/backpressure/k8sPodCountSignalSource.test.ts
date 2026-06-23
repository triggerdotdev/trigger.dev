import { describe, it, expect } from "vitest";
import { parsePodCount } from "./k8sPodCountSignalSource.js";

describe("parsePodCount", () => {
  it("reads the pods object count", () => {
    const text = [
      "# HELP apiserver_storage_objects Number of stored objects",
      "# TYPE apiserver_storage_objects gauge",
      'apiserver_storage_objects{resource="pods"} 8421',
      'apiserver_storage_objects{resource="configmaps"} 17',
    ].join("\n");
    expect(parsePodCount(text)).toBe(8421);
  });

  it("is tolerant of extra labels in any order", () => {
    const text = 'apiserver_storage_objects{group="",resource="pods",extra="x"} 12';
    expect(parsePodCount(text)).toBe(12);
  });

  it("parses scientific notation", () => {
    const text = 'apiserver_storage_objects{resource="pods"} 1.2e+04';
    expect(parsePodCount(text)).toBe(12000);
  });

  it("throws when the pods metric is absent", () => {
    const text = 'apiserver_storage_objects{resource="configmaps"} 17';
    expect(() => parsePodCount(text)).toThrow();
  });
});
