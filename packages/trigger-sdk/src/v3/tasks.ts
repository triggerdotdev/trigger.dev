import { InitOutput, RunOptions, Task, createTask } from "./shared";

export function task<TInput, TOutput = any, TInitOutput extends InitOutput = any>(
  options: RunOptions<TInput, TOutput, TInitOutput>
): Task<TInput, TOutput> {
  return createTask<TInput, TOutput, TInitOutput>(options);
}
