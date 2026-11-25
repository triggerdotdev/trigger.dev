type Obj = Record<string, unknown>;
type Spec = Obj & {
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, Record<string, unknown>>;
  security?: Record<string, unknown>[];
};

/**
 * One operation's part of an OpenAPI document, for agents reading an API page as markdown: the
 * document's header, that operation, and only the components it references (as the previous site
 * served). Undefined when the document has no such operation.
 */
export function operationSlice(spec: Spec, path: string, method: string): Obj | undefined {
  const item = spec.paths?.[path];
  const op = item?.[method] as Obj | undefined;
  if (!item || !op) return undefined;
  // Parameters declared on the path apply to every operation under it.
  const shared = item.parameters;
  const components: Record<string, Obj> = {};
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (k !== "$ref" || typeof v !== "string") {
        visit(v);
        continue;
      }
      const [, kind, name] = /^#\/components\/([^/]+)\/([^/]+)$/.exec(v) ?? [];
      if (!kind || !name || seen.has(v)) continue;
      seen.add(v);
      const target = spec.components?.[kind]?.[name];
      if (target === undefined) continue;
      (components[kind] ??= {})[name] = target;
      visit(target);
    }
  };
  visit(op);
  visit(shared);
  const security = (op.security as Obj[] | undefined) ?? spec.security ?? [];
  for (const name of security.flatMap((s) => Object.keys(s))) {
    const scheme = spec.components?.securitySchemes?.[name];
    if (scheme !== undefined) (components.securitySchemes ??= {})[name] = scheme;
  }
  return {
    openapi: spec.openapi,
    info: spec.info,
    servers: spec.servers,
    security: spec.security,
    paths: { [path]: { ...(shared ? { parameters: shared } : {}), [method]: op } },
    ...(Object.keys(components).length ? { components } : {}),
  };
}
