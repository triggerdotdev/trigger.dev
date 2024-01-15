import { PreparedItems, RunOptions, Task, createTask } from "./shared";

export function task<TInput, TOutput = any, TPreparedItems extends PreparedItems = any>(
  options: RunOptions<TInput, TOutput, TPreparedItems>
): Task<TInput, TOutput> {
  return createTask<TInput, TOutput, TPreparedItems>(options);
}
