/**
 * Basic JSON Schema type definition
 * Based on JSON Schema Draft 7
 */
export type JSONSchemaType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

export interface JSONSchema {
  $id?: string;
  $ref?: string;
  $schema?: string;
  $comment?: string;
  
  type?: JSONSchemaType | JSONSchemaType[];
  enum?: any[];
  const?: any;
  
  // Number/Integer validations
  multipleOf?: number;
  maximum?: number;
  exclusiveMaximum?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  
  // String validations
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  format?: string;
  
  // Array validations
  items?: JSONSchema | JSONSchema[];
  additionalItems?: JSONSchema | boolean;
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  contains?: JSONSchema;
  
  // Object validations
  maxProperties?: number;
  minProperties?: number;
  required?: string[];
  properties?: Record<string, JSONSchema>;
  patternProperties?: Record<string, JSONSchema>;
  additionalProperties?: JSONSchema | boolean;
  dependencies?: Record<string, JSONSchema | string[]>;
  propertyNames?: JSONSchema;
  
  // Conditionals
  if?: JSONSchema;
  then?: JSONSchema;
  else?: JSONSchema;
  
  // Boolean logic
  allOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  not?: JSONSchema;
  
  // Metadata
  title?: string;
  description?: string;
  default?: any;
  readOnly?: boolean;
  writeOnly?: boolean;
  examples?: any[];
  
  // Additional properties
  [key: string]: any;
}