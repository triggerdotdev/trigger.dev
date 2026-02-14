import { StandardSchemaV1 } from "@standard-schema/spec";

export type SchemaZodEsque<TInput, TParsedInput> = {
  _input: TInput;
  _output: TParsedInput;
};

export function isSchemaZodEsque<TInput, TParsedInput>(
  schema: Schema
): schema is SchemaZodEsque<TInput, TParsedInput> {
  return (
    typeof schema === "object" &&
    "_def" in schema &&
    "parse" in schema &&
    "parseAsync" in schema &&
    "safeParse" in schema
  );
}

export type SchemaValibotEsque<TInput, TParsedInput> = {
  schema: {
    _types?: {
      input: TInput;
      output: TParsedInput;
    };
  };
};

export function isSchemaValibotEsque<TInput, TParsedInput>(
  schema: Schema
): schema is SchemaValibotEsque<TInput, TParsedInput> {
  return typeof schema === "object" && "_types" in schema;
}

export type SchemaArkTypeEsque<TInput, TParsedInput> = {
  inferIn: TInput;
  infer: TParsedInput;
};

export function isSchemaArkTypeEsque<TInput, TParsedInput>(
  schema: Schema
): schema is SchemaArkTypeEsque<TInput, TParsedInput> {
  return typeof schema === "object" && "_inferIn" in schema && "_infer" in schema;
}

export function isSchemaStandardSchemaV1<TInput, TParsedInput>(
  schema: Schema
): schema is StandardSchemaV1<TInput, TParsedInput> {
  return typeof schema === "object" && "~standard" in schema && schema["~standard"].version === 1;
}

export type SchemaMyZodEsque<TInput> = {
  parse: (input: any) => TInput;
};

export type SchemaSuperstructEsque<TInput> = {
  create: (input: unknown) => TInput;
};

export type SchemaCustomValidatorEsque<TInput> = (input: unknown) => Promise<TInput> | TInput;

export type SchemaYupEsque<TInput> = {
  validateSync: (input: unknown) => TInput;
};

export type SchemaScaleEsque<TInput> = {
  assert(value: unknown): asserts value is TInput;
};

export type SchemaWithoutInput<TInput> =
  | SchemaCustomValidatorEsque<TInput>
  | SchemaMyZodEsque<TInput>
  | SchemaScaleEsque<TInput>
  | SchemaSuperstructEsque<TInput>
  | SchemaYupEsque<TInput>
  | StandardSchemaV1<TInput>;

export type SchemaWithInputOutput<TInput, TParsedInput> =
  | SchemaZodEsque<TInput, TParsedInput>
  | SchemaValibotEsque<TInput, TParsedInput>
  | SchemaArkTypeEsque<TInput, TParsedInput>
  | StandardSchemaV1<TInput, TParsedInput>;

export type Schema = SchemaWithInputOutput<any, any> | SchemaWithoutInput<any>;

export type inferSchema<TSchema extends Schema> = TSchema extends SchemaWithInputOutput<
  infer $TIn,
  infer $TOut
>
  ? {
      in: $TIn;
      out: $TOut;
    }
  : TSchema extends SchemaWithoutInput<infer $InOut>
  ? {
      in: $InOut;
      out: $InOut;
    }
  : never;

export type inferSchemaIn<
  TSchema extends Schema | undefined,
  TDefault = unknown,
> = TSchema extends Schema ? inferSchema<TSchema>["in"] : TDefault;

export type inferSchemaOut<
  TSchema extends Schema | undefined,
  TDefault = unknown,
> = TSchema extends Schema ? inferSchema<TSchema>["out"] : TDefault;

function issueToString(issue: StandardSchemaV1.Issue) :  string {
    return `{ message : ${issue.message} , path : ${issue.path}}`
}

class StandardSchemaV1ValidateError extends Error { 
    constructor(result : StandardSchemaV1.FailureResult){
       let message = `StandardSchemaV1 Validate Error [`
       result.issues.forEach((issue) => {
        message += ` ${issueToString(issue)}`
       })
       message += ' ]'
       super(message)
    }
}

export type SchemaParseFn<TType> = (value: unknown) => Promise<TType> | TType;
export type AnySchemaParseFn = SchemaParseFn<any>;

export function getSchemaParseFn<TType>(procedureParser: Schema): SchemaParseFn<TType> {
  const parser = procedureParser as any;                                                                                                                                                                                                                                                        

  if (typeof parser === "function" && typeof parser.assert === "function") {
    // ParserArkTypeEsque - arktype schemas shouldn't be called as a function because they return a union type instead of throwing
    return parser.assert.bind(parser);
  }

  if (typeof parser === "function") {
    // ParserValibotEsque (>= v0.31.0)
    // ParserCustomValidatorEsque
    return parser;
  }

  if (typeof parser.parseAsync === "function") {
    // ParserZodEsque
    return parser.parseAsync.bind(parser);
  }

  if (typeof parser.parse === "function") {
    // ParserZodEsque
    // ParserValibotEsque (< v0.13.0)
    return parser.parse.bind(parser);
  }

  if (typeof parser.validateSync === "function") {
    // ParserYupEsque
    return parser.validateSync.bind(parser);
  }

  if (typeof parser.create === "function") {
    // ParserSuperstructEsque
    return parser.create.bind(parser);
  }

  if (typeof parser.assert === "function") {
    // ParserScaleEsque
    return (value) => {
      parser.assert(value);
      return value as TType;
    };
  }

  if (parser["~standard"] && typeof parser["~standard"].validate === "function") {
    return (value) => {
      let response = parser["~standard"].validate(value);
      if ("value" in response) {
        return response["value"] as TType;
      }
      //FailureResult type
      throw new StandardSchemaV1ValidateError(response);
    };
  }
                                                                                                                                                                                                                                                        
  throw new Error("Could not find a validator fn");
}
