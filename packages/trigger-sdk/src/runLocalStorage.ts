import { IO } from "./io";
import { TriggerContext } from "./types";
import { TypedAsyncLocalStorage } from "./utils/typedAsyncLocalStorage";

export type RunStore = {
  io: IO;
  ctx: TriggerContext;
};

export const runLocalStorage = new TypedAsyncLocalStorage<RunStore>();
