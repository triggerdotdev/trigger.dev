import { anyApi, type ApiFromModules, type FilterApi, type FunctionReference } from "convex/server";
import type * as runs from "./runs.js";
import type * as worker from "./worker.js";

type Api = ApiFromModules<{ runs: typeof runs; worker: typeof worker }>;
export const internal = anyApi as unknown as FilterApi<Api, FunctionReference<any, "internal">>;
