import { z } from "zod";

type Action<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> = {
  id: string;
  name: string;
  description: string;
  input: TInput;
  output: TOutput;
};

type Actions = Record<string, Action<z.ZodTypeAny, z.ZodTypeAny>>;

type Integration<TActions extends Actions> = {
  [K in keyof TActions]: (
    data: z.infer<TActions[K]["input"]>
  ) => Promise<z.infer<TActions[K]["output"]>>;
};

export function createIntegration<TActions extends Actions>(
  actions: TActions
): Integration<TActions> {
  const integration = {} as Integration<TActions>;

  for (const [key, action] of Object.entries(actions)) {
    integration[key as keyof typeof integration] = async (data) => {
      return data;
    };
  }

  return integration;
}
