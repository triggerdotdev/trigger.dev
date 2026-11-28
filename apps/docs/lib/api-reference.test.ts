import { describe, expect, it } from "vitest";
import { orderedCodeSamples, withSchemaExamples } from "./api-reference";

describe("withSchemaExamples", () => {
  it("copies schema examples into `examples`, leaving parameters and media types alone", () => {
    const doc = {
      paths: {
        "/runs": {
          get: {
            parameters: [
              { name: "limit", in: "query", example: 10, schema: { type: "integer", example: 10 } },
            ],
            responses: {
              200: {
                content: {
                  "application/json": {
                    example: { id: "run_1" },
                    schema: { $ref: "#/components/schemas/Run" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Run: {
            type: "object",
            properties: {
              id: { type: "string", example: "run_1234" },
              example: { type: "string" },
              tags: { type: "array", items: { type: "string", example: "user_1" } },
              env: {
                allOf: [
                  { type: "object", properties: { name: { type: "string", example: "dev" } } },
                ],
              },
              kept: { type: "string", example: "a", examples: ["b"] },
            },
          },
        },
      },
    };
    const out = withSchemaExamples(doc);
    const run = out.components.schemas.Run.properties;
    expect(run.id).toEqual({ type: "string", example: "run_1234", examples: ["run_1234"] });
    expect(run.example).toEqual({ type: "string" });
    expect(run.tags.items).toMatchObject({ examples: ["user_1"] });
    expect(run.env.allOf[0]!.properties.name).toMatchObject({ examples: ["dev"] });
    expect(run.kept.examples).toEqual(["b"]);
    const param = out.paths["/runs"].get.parameters[0]!;
    expect(param).not.toHaveProperty("examples");
    expect(param.schema).toMatchObject({ examples: [10] });
    expect(out.paths["/runs"].get.responses[200].content["application/json"]).not.toHaveProperty(
      "examples"
    );
    // The input is not mutated.
    expect(doc.components.schemas.Run.properties.id).not.toHaveProperty("examples");
  });
});

type Sample = { id?: string; lang: string; label?: string; source: string };

describe("orderedCodeSamples", () => {
  const generated = [{ id: "curl" }, { id: "js" }, { id: "python" }];

  it("puts hand-written samples first and keeps every one of a language", () => {
    const samples: Sample[] = [
      { lang: "typescript", label: "Basic", source: "a" },
      { lang: "typescript", label: "Typed", source: "b" },
      { lang: "curl", label: "cURL basic", source: "c" },
      { lang: "curl", label: "cURL aggregate", source: "d" },
    ];
    const out = orderedCodeSamples(samples, generated);
    expect(out.map((s) => ("lang" in s ? (s.id ?? s.lang) : s.id))).toEqual([
      "typescript-0",
      "typescript",
      "curl-2",
      "curl",
      "js",
      "python",
    ]);
  });

  it("lists only the generated samples when there are none", () => {
    expect(orderedCodeSamples(undefined, generated)).toEqual(generated);
  });

  it("matches what fumadocs builds once it re-adds x-codeSamples by `id ?? lang`", () => {
    const samples: Sample[] = [
      { lang: "typescript", source: "a" },
      { lang: "typescript", source: "b" },
    ];
    const registry = new Map<string, unknown>();
    for (const s of orderedCodeSamples(samples, generated))
      registry.set("lang" in s ? (s.id ?? s.lang) : s.id, s);
    for (const s of samples) registry.set(s.lang, s);
    expect([...registry.keys()]).toEqual(["typescript-0", "typescript", "curl", "js", "python"]);
    expect(registry.get("typescript")).toBe(samples[1]);
  });
});
