import { AnySchemaParseFn, inferSchemaIn, inferSchemaOut, Schema } from "./schemas.js";

export type HttpCallbackSchema = Schema;
export type HttpCallbackResultTypeFromSchema<TSchema extends HttpCallbackSchema> =
  inferSchemaOut<TSchema>;
export type HttpCallbackResult<TResult> =
  | {
      ok: true;
      result: TResult;
    }
  | {
      ok: false;
      error: Error;
    };
