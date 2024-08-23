import { IO } from "./io.js";
import { TriggerContext } from "./types.js";
import { TypedAsyncLocalStorage } from "./utils/typedAsyncLocalStorage.js";

export type RunStore = {
  io: IO;
  ctx: TriggerContext;
};

export const runLocalStorage = new TypedAsyncLocalStorage<RunStore>();
