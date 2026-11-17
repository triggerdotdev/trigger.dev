import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_FORM_ENTRIES,
  MAX_LIST_ITEMS,
  MAX_PATH_SEGMENTS,
  MAX_VALUES_PER_FIELD,
  formSizeError,
  parseWithZod,
} from "~/utils/conform";

function form(entries: Array<[string, string]>) {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

const schema = z.object({
  variables: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  environmentIds: z.array(z.string()).optional(),
});

describe("parseWithZod", () => {
  // Catches: the wrapper changing what Conform returns for an ordinary list form.
  it("parses list fields as Conform does", () => {
    const rows = Array.from({ length: 500 }, (_, i): Array<[string, string]> => [
      [`variables[${i}].key`, `KEY_${i}`],
      [`variables[${i}].value`, `value ${i}`],
    ]).flat();
    const submission = parseWithZod(
      form([...rows, ["environmentIds", "a"], ["environmentIds", "b"]]),
      { schema }
    );

    expect(submission.status).toBe("success");
    if (submission.status !== "success") return;
    expect(submission.value.variables).toHaveLength(500);
    expect(submission.value.variables?.[499]).toEqual({ key: "KEY_499", value: "value 499" });
    expect(submission.value.environmentIds).toEqual(["a", "b"]);
  });

  // Catches: the wrapper only handling FormData payloads.
  it("parses URLSearchParams", () => {
    const submission = parseWithZod(
      new URLSearchParams("variables[0].key=A&variables[0].value=1"),
      {
        schema,
      }
    );
    expect(submission.status).toBe("success");
  });

  // Catches: a form over the limits reaching Conform instead of getting a form error.
  it("returns a form error for a list index past the limit", () => {
    const submission = parseWithZod(form([["variables[1000000].key", "x"]]), { schema });

    expect(submission.status).toBe("error");
    expect(submission.error?.[""]).toEqual(["This form has too many fields or list items."]);
    expect(submission.reply().error?.[""]).toHaveLength(1);
  });

  // Catches: an async caller getting a plain object back.
  it("returns a promise when parsing asynchronously", async () => {
    const submission = await parseWithZod(form([["variables[1000000].key", "x"]]), {
      schema,
      async: true,
    });
    expect(submission.status).toBe("error");
  });
});

// Catches: a path form that the limits do not count.
describe("formSizeError", () => {
  it.each([
    ["the last allowed index", `variables[${MAX_LIST_ITEMS - 1}].key`],
    ["a numeric key on an object", "metadata.10"],
    ["an empty index", "tags[]"],
  ])("accepts %s", (_, name) => {
    expect(formSizeError(form([[name, "x"]]))).toBeUndefined();
  });

  it.each([
    ["a bracket index", `variables[${MAX_LIST_ITEMS}].key`],
    ["a dot index", `variables.${MAX_LIST_ITEMS}.key`],
    ["an inner index", "variables[0].tags[50000000]"],
    ["an outer index with an inner one", "variables[50000000].tags[0]"],
    ["an index on a field the schema does not have", "anything[50000000]"],
    ["a padded index", "variables[000000000010000000]"],
  ])("refuses %s", (_, name) => {
    expect(formSizeError(form([[name, "x"]]))).toBeDefined();
  });

  it("counts list items across every list in the form", () => {
    const names = Array.from({ length: 20 }, (_, i): [string, string] => [`list${i}[999]`, "x"]);
    expect(formSizeError(form(names))).toBeDefined();
    expect(formSizeError(form(names.slice(0, 9)))).toBeUndefined();
  });

  it("limits how many values one field name can carry", () => {
    const values = (count: number) =>
      Array.from({ length: count }, (): [string, string] => ["selectedRunIds", "run"]);
    expect(formSizeError(form(values(MAX_VALUES_PER_FIELD)))).toBeUndefined();
    expect(formSizeError(form(values(MAX_VALUES_PER_FIELD + 1)))).toBeDefined();
  });

  it("limits the total number of fields", () => {
    const names = Array.from({ length: MAX_FORM_ENTRIES + 1 }, (_, i): [string, string] => [
      `field${i}`,
      "x",
    ]);
    expect(formSizeError(form(names))).toBeDefined();
  });

  it("checks the list index of a Conform intent", () => {
    const intent = (payload: object) =>
      form([["__intent__", JSON.stringify({ type: "update", payload })]]);

    expect(formSizeError(intent({ name: "variables", index: 3, value: "x" }))).toBeUndefined();
    expect(formSizeError(intent({ name: "variables", index: 50000000, value: "x" }))).toBeDefined();
    expect(formSizeError(intent({ name: "variables[50000000]", value: "x" }))).toBeDefined();
    expect(formSizeError(intent({ name: "variables", index: "50000000" }))).toBeDefined();
    expect(formSizeError(intent({ name: "variables", index: 1.5 }))).toBeDefined();
    expect(formSizeError(intent({ name: ["variables", 50000000], value: "x" }))).toBeDefined();
    expect(formSizeError(intent({ value: "x" }))).toBeUndefined();
  });

  it("allows one intent and one state field", () => {
    const intent = JSON.stringify({ type: "validate", payload: { name: "variables" } });
    expect(formSizeError(form([["__intent__", intent]]))).toBeUndefined();
    expect(
      formSizeError(
        form([
          ["__intent__", intent],
          ["__intent__", intent],
        ])
      )
    ).toBeDefined();
    expect(
      formSizeError(
        form([
          ["__state__", "{}"],
          ["__state__", "{}"],
        ])
      )
    ).toBeDefined();
  });

  it("limits how deeply a field name nests", () => {
    const name = (depth: number) => "variables" + "[0]".repeat(depth);
    expect(formSizeError(form([[name(MAX_PATH_SEGMENTS - 2), "x"]]))).toBeUndefined();
    expect(formSizeError(form([[name(MAX_PATH_SEGMENTS), "x"]]))).toBeDefined();
    expect(formSizeError(form([[name(16000), "x"]]))).toBeDefined();
  });

  it("checks the keys of Conform state", () => {
    const state = (keys: string[]) =>
      form([["__state__", JSON.stringify(Object.fromEntries(keys.map((key) => [key, 1])))]]);

    expect(formSizeError(state(["variables[2]"]))).toBeUndefined();
    expect(formSizeError(state(["variables[50000000]"]))).toBeDefined();
  });
});
