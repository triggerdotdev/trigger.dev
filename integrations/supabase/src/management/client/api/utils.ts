import { Prettify } from "@trigger.dev/integration-kit";

export type ExtractResponseContent<
  TOperation,
  TMethod extends "get" | "post",
  TStatus extends number,
  TMime extends string = "application/json"
> = TOperation extends {
  [method in TMethod]: {
    responses: {
      [status in TStatus]: {
        content: {
          [mime in TMime]: infer TData;
        };
      };
    };
  };
}
  ? Prettify<TData> | undefined
  : never;
