import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as runs from "../runs.js";

type PublicApi = FilterApi<ApiFromModules<{ runs: typeof runs }>, FunctionReference<any, "public">>;

// Derive the component boundary from its functions, so it cannot drift from their validators.
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  runs: {
    [Key in keyof PublicApi["runs"]]: PublicApi["runs"][Key] extends FunctionReference<
      infer Type,
      any,
      infer Args,
      infer Result
    >
      ? FunctionReference<Type, "internal", Args, Result, Name>
      : never;
  };
};
