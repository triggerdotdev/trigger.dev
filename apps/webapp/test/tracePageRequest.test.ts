import { describe, expect, it } from "vitest";
import { encodeTraceCursor } from "~/v3/eventRepository/traceCursor";
import {
  MAX_TRACE_PAGE_SIZE,
  MIN_TRACE_PAGE_SIZE,
  parseTracePageRequest,
} from "~/v3/eventRepository/tracePageRequest";

const parse = (query: string) => parseTracePageRequest(new URLSearchParams(query), 10_000);

describe("parseTracePageRequest", () => {
  it("returns null without page params, ignoring anything else", () => {
    for (const query of ["", "limit=abc", "cursor=x", "page=2"]) {
      const result = parse(query);
      expect(result.isOk() && result.value).toBeNull();
    }
  });

  it("treats page[size] alone as the first page", () => {
    const result = parse("page[size]=2500");
    expect(result.isOk() && result.value).toEqual({ limit: 2500, after: undefined });
  });

  it("uses the default size when only page[after] is sent", () => {
    const cursor = { startTime: "1756720800000000000", spanId: "abc" };
    const result = parse(`page[after]=${encodeTraceCursor(cursor)}`);
    expect(result.isOk() && result.value).toEqual({ limit: 10_000, after: cursor });
  });

  it("clamps the page size", () => {
    const small = parse("page[size]=1");
    const large = parse("page[size]=999999");
    expect(small.isOk() && small.value?.limit).toBe(MIN_TRACE_PAGE_SIZE);
    expect(large.isOk() && large.value?.limit).toBe(MAX_TRACE_PAGE_SIZE);
  });

  it.each(["abc", "0", "-5", "1.5", ""])("rejects page[size]=%s", (size) => {
    const result = parse(`page[size]=${size}`);
    expect(result.isErr() && result.error).toBe("invalid_page_size");
  });

  it("rejects a bad page[after] instead of starting over", () => {
    for (const after of ["", "nope", encodeURIComponent(btoa('{"t":"1"}'))]) {
      const result = parse(`page[size]=100&page[after]=${after}`);
      expect(result.isErr() && result.error).toBe("invalid_cursor");
    }
  });
});
