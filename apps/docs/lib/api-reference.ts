// How API pages present the OpenAPI spec. Pure, so the client page and the server can both use it.

// Keys whose value is a schema, a list of schemas, or a map of named schemas.
const schemaKeys = new Set([
  "schema",
  "itemSchema",
  "items",
  "additionalProperties",
  "not",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
]);
const schemaListKeys = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaMapKeys = new Set(["properties", "patternProperties", "schemas", "$defs"]);

/**
 * The document with each schema's OpenAPI 3.0 `example` also as JSON Schema `examples`, the only
 * one fumadocs reads when it builds example requests and responses (else `"id": "string"`).
 * Parameter and media type `example`s are left alone: their `examples` is a map, not a list.
 */
export function withSchemaExamples<T>(doc: T): T {
  const walk = (value: unknown, isSchema: boolean): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, false));
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (schemaKeys.has(k)) out[k] = walk(v, true);
      else if (schemaListKeys.has(k) && Array.isArray(v)) out[k] = v.map((s) => walk(s, true));
      else if (schemaMapKeys.has(k) && v && typeof v === "object" && !Array.isArray(v))
        out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, walk(s, true)]));
      else out[k] = walk(v, false);
    }
    if (isSchema && out.example !== undefined && out.examples === undefined)
      out.examples = [out.example];
    return out;
  };
  return walk(doc, false) as T;
}

type Sample = { id?: string; lang: string };

/**
 * The code samples for an operation's example card: its hand-written `x-codeSamples` (the SDK
 * calls) first, so the first one is the default, then the generated ones.
 *
 * fumadocs keys samples by `id ?? lang` and adds `x-codeSamples` again after these. So every sample
 * but the last of its language gets its own id (else only the last survives), and the last keeps
 * the `lang` key, which that second pass then overwrites in place with the same sample.
 */
export function orderedCodeSamples<S extends Sample, G extends { id: string }>(
  samples: S[] | undefined,
  generated: G[]
): (S | G)[] {
  const list = samples ?? [];
  const last = new Map(list.map((s, i) => [s.lang, i]));
  const own = list.map((s, i) =>
    s.id || last.get(s.lang) === i ? s : { ...s, id: `${s.lang}-${i}` }
  );
  const taken = new Set(own.map((s) => s.id ?? s.lang));
  return [...own, ...generated.filter((g) => !taken.has(g.id))];
}
