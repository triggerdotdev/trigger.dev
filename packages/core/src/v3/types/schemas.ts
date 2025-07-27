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
  | SchemaYupEsque<TInput>;

export type SchemaWithInputOutput<TInput, TParsedInput> =
  | SchemaZodEsque<TInput, TParsedInput>
  | SchemaValibotEsque<TInput, TParsedInput>
  | SchemaArkTypeEsque<TInput, TParsedInput>;

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

  throw new Error("Could not find a validator fn");
}

export function getSchemaToJsonSchema(schema: Schema): any | undefined {
  const parser = schema as any;

  // Check if schema has a built-in toJsonSchema method (e.g., ArkType)
  if (typeof parser.toJsonSchema === "function") {
    return parser.toJsonSchema();
  }

  // Check if it's a Zod schema
  if (typeof parser.parseAsync === "function" || typeof parser.parse === "function") {
    // Zod schema detected, but we need zod-to-json-schema library to convert
    // Return undefined for now, will be handled by the caller
    return undefined;
  }

  // Check if it's a Yup schema
  if (typeof parser.validateSync === "function") {
    // Yup schema detected, but we need a yup-to-json-schema library to convert
    // Return undefined for now, will be handled by the caller
    return undefined;
  }

  // Check if it's an Effect schema
  if (parser._tag === "Schema" || parser._tag === "SchemaClass") {
    // Effect schema detected, but we need Effect's JSONSchema.make to convert
    // Return undefined for now, will be handled by the caller
    return undefined;
  }

  // For other schema types, return undefined
  return undefined;
}
