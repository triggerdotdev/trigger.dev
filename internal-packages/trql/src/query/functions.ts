// TypeScript port of posthog/hogql/functions/mapping.py and aggregations.py
// Keep this file in sync with the Python version

import { CompareOperationOp } from "./ast";

/**
 * Metadata for a TRQL function
 */
export interface TRQLFunctionMeta {
  /** The ClickHouse function name to use */
  clickhouseName: string;
  /** Minimum number of arguments */
  minArgs: number;
  /** Maximum number of arguments (undefined means unlimited) */
  maxArgs?: number;
  /** Minimum number of parameters (for parametric functions) */
  minParams?: number;
  /** Maximum number of parameters */
  maxParams?: number;
  /** Whether this is an aggregate function */
  aggregate?: boolean;
  /** Whether function is case-sensitive */
  caseSensitive?: boolean;
  /** Whether function is timezone-aware (will append timezone as last arg) */
  tzAware?: boolean;
  /** Whether the function uses placeholder arguments like {} */
  usingPlaceholderArguments?: boolean;
}

/**
 * Comparison function mappings from function names to CompareOperationOp
 */
export const TRQL_COMPARISON_MAPPING: Record<string, CompareOperationOp> = {
  equals: CompareOperationOp.Eq,
  notEquals: CompareOperationOp.NotEq,
  less: CompareOperationOp.Lt,
  greater: CompareOperationOp.Gt,
  lessOrEquals: CompareOperationOp.LtEq,
  greaterOrEquals: CompareOperationOp.GtEq,
  like: CompareOperationOp.Like,
  ilike: CompareOperationOp.ILike,
  notLike: CompareOperationOp.NotLike,
  notILike: CompareOperationOp.NotILike,
  in: CompareOperationOp.In,
  notIn: CompareOperationOp.NotIn,
};

/**
 * ClickHouse functions available in TRQL
 * Port of HOGQL_CLICKHOUSE_FUNCTIONS from mapping.py
 */
export const TRQL_CLICKHOUSE_FUNCTIONS: Record<string, TRQLFunctionMeta> = {
  // Comparison
  equals: { clickhouseName: "equals", minArgs: 2, maxArgs: 2 },
  notEquals: { clickhouseName: "notEquals", minArgs: 2, maxArgs: 2 },
  less: { clickhouseName: "less", minArgs: 2, maxArgs: 2 },
  greater: { clickhouseName: "greater", minArgs: 2, maxArgs: 2 },
  lessOrEquals: { clickhouseName: "lessOrEquals", minArgs: 2, maxArgs: 2 },
  greaterOrEquals: { clickhouseName: "greaterOrEquals", minArgs: 2, maxArgs: 2 },

  // Logical
  and: { clickhouseName: "and", minArgs: 2 },
  or: { clickhouseName: "or", minArgs: 2 },
  xor: { clickhouseName: "xor", minArgs: 2 },
  not: { clickhouseName: "not", minArgs: 1, maxArgs: 1, caseSensitive: false },

  // Conditional
  if: { clickhouseName: "if", minArgs: 3, maxArgs: 3, caseSensitive: false },
  multiIf: { clickhouseName: "multiIf", minArgs: 3 },

  // In
  in: { clickhouseName: "in", minArgs: 2, maxArgs: 2 },
  notIn: { clickhouseName: "notIn", minArgs: 2, maxArgs: 2 },

  // Arithmetic
  plus: { clickhouseName: "plus", minArgs: 2, maxArgs: 2 },
  minus: { clickhouseName: "minus", minArgs: 2, maxArgs: 2 },
  multiply: { clickhouseName: "multiply", minArgs: 2, maxArgs: 2 },
  divide: { clickhouseName: "divide", minArgs: 2, maxArgs: 2 },
  intDiv: { clickhouseName: "intDiv", minArgs: 2, maxArgs: 2 },
  intDivOrZero: { clickhouseName: "intDivOrZero", minArgs: 2, maxArgs: 2 },
  modulo: { clickhouseName: "modulo", minArgs: 2, maxArgs: 2 },
  moduloOrZero: { clickhouseName: "moduloOrZero", minArgs: 2, maxArgs: 2 },
  positiveModulo: { clickhouseName: "positiveModulo", minArgs: 2, maxArgs: 2 },
  negate: { clickhouseName: "negate", minArgs: 1, maxArgs: 1 },
  abs: { clickhouseName: "abs", minArgs: 1, maxArgs: 1 },
  gcd: { clickhouseName: "gcd", minArgs: 2, maxArgs: 2 },
  lcm: { clickhouseName: "lcm", minArgs: 2, maxArgs: 2 },

  // Mathematical
  exp: { clickhouseName: "exp", minArgs: 1, maxArgs: 1 },
  log: { clickhouseName: "log", minArgs: 1, maxArgs: 1 },
  ln: { clickhouseName: "log", minArgs: 1, maxArgs: 1 },
  exp2: { clickhouseName: "exp2", minArgs: 1, maxArgs: 1 },
  log2: { clickhouseName: "log2", minArgs: 1, maxArgs: 1 },
  exp10: { clickhouseName: "exp10", minArgs: 1, maxArgs: 1 },
  log10: { clickhouseName: "log10", minArgs: 1, maxArgs: 1 },
  sqrt: { clickhouseName: "sqrt", minArgs: 1, maxArgs: 1 },
  cbrt: { clickhouseName: "cbrt", minArgs: 1, maxArgs: 1 },
  erf: { clickhouseName: "erf", minArgs: 1, maxArgs: 1 },
  erfc: { clickhouseName: "erfc", minArgs: 1, maxArgs: 1 },
  lgamma: { clickhouseName: "lgamma", minArgs: 1, maxArgs: 1 },
  tgamma: { clickhouseName: "tgamma", minArgs: 1, maxArgs: 1 },
  sin: { clickhouseName: "sin", minArgs: 1, maxArgs: 1 },
  cos: { clickhouseName: "cos", minArgs: 1, maxArgs: 1 },
  tan: { clickhouseName: "tan", minArgs: 1, maxArgs: 1 },
  asin: { clickhouseName: "asin", minArgs: 1, maxArgs: 1 },
  acos: { clickhouseName: "acos", minArgs: 1, maxArgs: 1 },
  atan: { clickhouseName: "atan", minArgs: 1, maxArgs: 1 },
  pow: { clickhouseName: "pow", minArgs: 2, maxArgs: 2 },
  power: { clickhouseName: "power", minArgs: 2, maxArgs: 2 },
  round: { clickhouseName: "round", minArgs: 1, maxArgs: 2 },
  floor: { clickhouseName: "floor", minArgs: 1, maxArgs: 2 },
  ceil: { clickhouseName: "ceil", minArgs: 1, maxArgs: 2 },
  ceiling: { clickhouseName: "ceiling", minArgs: 1, maxArgs: 2 },
  trunc: { clickhouseName: "trunc", minArgs: 1, maxArgs: 2 },
  truncate: { clickhouseName: "truncate", minArgs: 1, maxArgs: 2 },
  sign: { clickhouseName: "sign", minArgs: 1, maxArgs: 1 },

  // String functions
  empty: { clickhouseName: "empty", minArgs: 1, maxArgs: 1 },
  notEmpty: { clickhouseName: "notEmpty", minArgs: 1, maxArgs: 1 },
  length: { clickhouseName: "length", minArgs: 1, maxArgs: 1 },
  lengthUTF8: { clickhouseName: "lengthUTF8", minArgs: 1, maxArgs: 1 },
  char_length: { clickhouseName: "char_length", minArgs: 1, maxArgs: 1 },
  character_length: { clickhouseName: "character_length", minArgs: 1, maxArgs: 1 },
  lower: { clickhouseName: "lower", minArgs: 1, maxArgs: 1 },
  upper: { clickhouseName: "upper", minArgs: 1, maxArgs: 1 },
  lowerUTF8: { clickhouseName: "lowerUTF8", minArgs: 1, maxArgs: 1 },
  upperUTF8: { clickhouseName: "upperUTF8", minArgs: 1, maxArgs: 1 },
  reverse: { clickhouseName: "reverse", minArgs: 1, maxArgs: 1 },
  reverseUTF8: { clickhouseName: "reverseUTF8", minArgs: 1, maxArgs: 1 },
  concat: { clickhouseName: "concat", minArgs: 1 },
  concatAssumeInjective: { clickhouseName: "concatAssumeInjective", minArgs: 1 },
  substring: { clickhouseName: "substring", minArgs: 2, maxArgs: 3 },
  substr: { clickhouseName: "substring", minArgs: 2, maxArgs: 3 },
  mid: { clickhouseName: "substring", minArgs: 2, maxArgs: 3 },
  substringUTF8: { clickhouseName: "substringUTF8", minArgs: 2, maxArgs: 3 },
  appendTrailingCharIfAbsent: { clickhouseName: "appendTrailingCharIfAbsent", minArgs: 2, maxArgs: 2 },
  convertCharset: { clickhouseName: "convertCharset", minArgs: 3, maxArgs: 3 },
  base58Encode: { clickhouseName: "base58Encode", minArgs: 1, maxArgs: 1 },
  base58Decode: { clickhouseName: "base58Decode", minArgs: 1, maxArgs: 1 },
  base64Encode: { clickhouseName: "base64Encode", minArgs: 1, maxArgs: 1 },
  base64Decode: { clickhouseName: "base64Decode", minArgs: 1, maxArgs: 1 },
  tryBase64Decode: { clickhouseName: "tryBase64Decode", minArgs: 1, maxArgs: 1 },
  endsWith: { clickhouseName: "endsWith", minArgs: 2, maxArgs: 2 },
  startsWith: { clickhouseName: "startsWith", minArgs: 2, maxArgs: 2 },
  trim: { clickhouseName: "trim", minArgs: 1, maxArgs: 2 },
  trimLeft: { clickhouseName: "trimLeft", minArgs: 1, maxArgs: 2 },
  trimRight: { clickhouseName: "trimRight", minArgs: 1, maxArgs: 2 },
  ltrim: { clickhouseName: "trimLeft", minArgs: 1, maxArgs: 1 },
  rtrim: { clickhouseName: "trimRight", minArgs: 1, maxArgs: 1 },
  leftPad: { clickhouseName: "leftPad", minArgs: 2, maxArgs: 3 },
  rightPad: { clickhouseName: "rightPad", minArgs: 2, maxArgs: 3 },
  leftPadUTF8: { clickhouseName: "leftPadUTF8", minArgs: 2, maxArgs: 3 },
  rightPadUTF8: { clickhouseName: "rightPadUTF8", minArgs: 2, maxArgs: 3 },
  left: { clickhouseName: "left", minArgs: 2, maxArgs: 2 },
  right: { clickhouseName: "right", minArgs: 2, maxArgs: 2 },
  repeat: { clickhouseName: "repeat", minArgs: 2, maxArgs: 2 },
  space: { clickhouseName: "space", minArgs: 1, maxArgs: 1 },
  replace: { clickhouseName: "replace", minArgs: 3, maxArgs: 3 },
  replaceOne: { clickhouseName: "replaceOne", minArgs: 3, maxArgs: 3 },
  replaceAll: { clickhouseName: "replaceAll", minArgs: 3, maxArgs: 3 },
  replaceRegexpOne: { clickhouseName: "replaceRegexpOne", minArgs: 3, maxArgs: 3 },
  replaceRegexpAll: { clickhouseName: "replaceRegexpAll", minArgs: 3, maxArgs: 3 },
  position: { clickhouseName: "position", minArgs: 2, maxArgs: 2 },
  positionCaseInsensitive: { clickhouseName: "positionCaseInsensitive", minArgs: 2, maxArgs: 2 },
  positionUTF8: { clickhouseName: "positionUTF8", minArgs: 2, maxArgs: 2 },
  positionCaseInsensitiveUTF8: { clickhouseName: "positionCaseInsensitiveUTF8", minArgs: 2, maxArgs: 2 },
  locate: { clickhouseName: "locate", minArgs: 2, maxArgs: 2 },
  match: { clickhouseName: "match", minArgs: 2, maxArgs: 2 },
  multiMatchAny: { clickhouseName: "multiMatchAny", minArgs: 2, maxArgs: 2 },
  multiMatchAnyIndex: { clickhouseName: "multiMatchAnyIndex", minArgs: 2, maxArgs: 2 },
  multiMatchAllIndices: { clickhouseName: "multiMatchAllIndices", minArgs: 2, maxArgs: 2 },
  multiSearchFirstPosition: { clickhouseName: "multiSearchFirstPosition", minArgs: 2, maxArgs: 2 },
  multiSearchFirstIndex: { clickhouseName: "multiSearchFirstIndex", minArgs: 2, maxArgs: 2 },
  multiSearchAny: { clickhouseName: "multiSearchAny", minArgs: 2, maxArgs: 2 },
  extract: { clickhouseName: "extract", minArgs: 2, maxArgs: 2 },
  extractAll: { clickhouseName: "extractAll", minArgs: 2, maxArgs: 2 },
  extractAllGroupsHorizontal: { clickhouseName: "extractAllGroupsHorizontal", minArgs: 2, maxArgs: 2 },
  extractAllGroupsVertical: { clickhouseName: "extractAllGroupsVertical", minArgs: 2, maxArgs: 2 },
  like: { clickhouseName: "like", minArgs: 2, maxArgs: 2 },
  ilike: { clickhouseName: "ilike", minArgs: 2, maxArgs: 2 },
  notLike: { clickhouseName: "notLike", minArgs: 2, maxArgs: 2 },
  notILike: { clickhouseName: "notILike", minArgs: 2, maxArgs: 2 },
  splitByChar: { clickhouseName: "splitByChar", minArgs: 2, maxArgs: 3 },
  splitByString: { clickhouseName: "splitByString", minArgs: 2, maxArgs: 3 },
  splitByRegexp: { clickhouseName: "splitByRegexp", minArgs: 2, maxArgs: 3 },
  arrayStringConcat: { clickhouseName: "arrayStringConcat", minArgs: 1, maxArgs: 2 },
  format: { clickhouseName: "format", minArgs: 1 },
  coalesce: { clickhouseName: "coalesce", minArgs: 1 },
  ifNull: { clickhouseName: "ifNull", minArgs: 2, maxArgs: 2 },
  nullIf: { clickhouseName: "nullIf", minArgs: 2, maxArgs: 2 },
  assumeNotNull: { clickhouseName: "assumeNotNull", minArgs: 1, maxArgs: 1 },
  toNullable: { clickhouseName: "toNullable", minArgs: 1, maxArgs: 1 },
  isNull: { clickhouseName: "isNull", minArgs: 1, maxArgs: 1 },
  isNotNull: { clickhouseName: "isNotNull", minArgs: 1, maxArgs: 1 },

  // Type conversions
  toString: { clickhouseName: "toString", minArgs: 1, maxArgs: 1 },
  toFixedString: { clickhouseName: "toFixedString", minArgs: 2, maxArgs: 2 },
  toUInt8: { clickhouseName: "toUInt8", minArgs: 1, maxArgs: 1 },
  toUInt16: { clickhouseName: "toUInt16", minArgs: 1, maxArgs: 1 },
  toUInt32: { clickhouseName: "toUInt32", minArgs: 1, maxArgs: 1 },
  toUInt64: { clickhouseName: "toUInt64", minArgs: 1, maxArgs: 1 },
  toInt8: { clickhouseName: "toInt8", minArgs: 1, maxArgs: 1 },
  toInt16: { clickhouseName: "toInt16", minArgs: 1, maxArgs: 1 },
  toInt32: { clickhouseName: "toInt32", minArgs: 1, maxArgs: 1 },
  toInt64: { clickhouseName: "toInt64", minArgs: 1, maxArgs: 1 },
  toInt128: { clickhouseName: "toInt128", minArgs: 1, maxArgs: 1 },
  toInt256: { clickhouseName: "toInt256", minArgs: 1, maxArgs: 1 },
  toUInt128: { clickhouseName: "toUInt128", minArgs: 1, maxArgs: 1 },
  toUInt256: { clickhouseName: "toUInt256", minArgs: 1, maxArgs: 1 },
  toFloat32: { clickhouseName: "toFloat32", minArgs: 1, maxArgs: 1 },
  toFloat64: { clickhouseName: "toFloat64", minArgs: 1, maxArgs: 1 },
  toDecimal32: { clickhouseName: "toDecimal32", minArgs: 2, maxArgs: 2 },
  toDecimal64: { clickhouseName: "toDecimal64", minArgs: 2, maxArgs: 2 },
  toDecimal128: { clickhouseName: "toDecimal128", minArgs: 2, maxArgs: 2 },
  toDecimal256: { clickhouseName: "toDecimal256", minArgs: 2, maxArgs: 2 },
  toDate: { clickhouseName: "toDate", minArgs: 1, maxArgs: 2 },
  toDateOrNull: { clickhouseName: "toDateOrNull", minArgs: 1, maxArgs: 2 },
  toDateOrZero: { clickhouseName: "toDateOrZero", minArgs: 1, maxArgs: 2 },
  toDate32: { clickhouseName: "toDate32", minArgs: 1, maxArgs: 2 },
  toDate32OrNull: { clickhouseName: "toDate32OrNull", minArgs: 1, maxArgs: 2 },
  toDate32OrZero: { clickhouseName: "toDate32OrZero", minArgs: 1, maxArgs: 2 },
  toDateTime: { clickhouseName: "toDateTime", minArgs: 1, maxArgs: 2 },
  toDateTimeOrNull: { clickhouseName: "toDateTimeOrNull", minArgs: 1, maxArgs: 2 },
  toDateTimeOrZero: { clickhouseName: "toDateTimeOrZero", minArgs: 1, maxArgs: 2 },
  toDateTime64: { clickhouseName: "toDateTime64", minArgs: 1, maxArgs: 3 },
  toDateTime64OrNull: { clickhouseName: "toDateTime64OrNull", minArgs: 1, maxArgs: 3 },
  toDateTime64OrZero: { clickhouseName: "toDateTime64OrZero", minArgs: 1, maxArgs: 3 },
  toUUID: { clickhouseName: "toUUID", minArgs: 1, maxArgs: 1 },
  toUUIDOrNull: { clickhouseName: "toUUIDOrNull", minArgs: 1, maxArgs: 1 },
  toUUIDOrZero: { clickhouseName: "toUUIDOrZero", minArgs: 1, maxArgs: 1 },
  toTypeName: { clickhouseName: "toTypeName", minArgs: 1, maxArgs: 1 },

  // Date/time functions
  now: { clickhouseName: "now", minArgs: 0, maxArgs: 1, tzAware: true },
  now64: { clickhouseName: "now64", minArgs: 0, maxArgs: 2, tzAware: true },
  today: { clickhouseName: "today", minArgs: 0, maxArgs: 0 },
  yesterday: { clickhouseName: "yesterday", minArgs: 0, maxArgs: 0 },
  toYear: { clickhouseName: "toYear", minArgs: 1, maxArgs: 1 },
  toQuarter: { clickhouseName: "toQuarter", minArgs: 1, maxArgs: 1 },
  toMonth: { clickhouseName: "toMonth", minArgs: 1, maxArgs: 1 },
  toDayOfYear: { clickhouseName: "toDayOfYear", minArgs: 1, maxArgs: 1 },
  toDayOfMonth: { clickhouseName: "toDayOfMonth", minArgs: 1, maxArgs: 1 },
  toDayOfWeek: { clickhouseName: "toDayOfWeek", minArgs: 1, maxArgs: 3 },
  toHour: { clickhouseName: "toHour", minArgs: 1, maxArgs: 1 },
  toMinute: { clickhouseName: "toMinute", minArgs: 1, maxArgs: 1 },
  toSecond: { clickhouseName: "toSecond", minArgs: 1, maxArgs: 1 },
  toUnixTimestamp: { clickhouseName: "toUnixTimestamp", minArgs: 1, maxArgs: 2 },
  toStartOfYear: { clickhouseName: "toStartOfYear", minArgs: 1, maxArgs: 1 },
  toStartOfQuarter: { clickhouseName: "toStartOfQuarter", minArgs: 1, maxArgs: 1 },
  toStartOfMonth: { clickhouseName: "toStartOfMonth", minArgs: 1, maxArgs: 1 },
  toMonday: { clickhouseName: "toMonday", minArgs: 1, maxArgs: 1 },
  toStartOfWeek: { clickhouseName: "toStartOfWeek", minArgs: 1, maxArgs: 2 },
  toStartOfDay: { clickhouseName: "toStartOfDay", minArgs: 1, maxArgs: 1 },
  toStartOfHour: { clickhouseName: "toStartOfHour", minArgs: 1, maxArgs: 1 },
  toStartOfMinute: { clickhouseName: "toStartOfMinute", minArgs: 1, maxArgs: 1 },
  toStartOfSecond: { clickhouseName: "toStartOfSecond", minArgs: 1, maxArgs: 1 },
  toStartOfFiveMinutes: { clickhouseName: "toStartOfFiveMinutes", minArgs: 1, maxArgs: 1 },
  toStartOfTenMinutes: { clickhouseName: "toStartOfTenMinutes", minArgs: 1, maxArgs: 1 },
  toStartOfFifteenMinutes: { clickhouseName: "toStartOfFifteenMinutes", minArgs: 1, maxArgs: 1 },
  toStartOfInterval: { clickhouseName: "toStartOfInterval", minArgs: 2, maxArgs: 4 },
  toTime: { clickhouseName: "toTime", minArgs: 1, maxArgs: 2 },
  toISOYear: { clickhouseName: "toISOYear", minArgs: 1, maxArgs: 1 },
  toISOWeek: { clickhouseName: "toISOWeek", minArgs: 1, maxArgs: 1 },
  toWeek: { clickhouseName: "toWeek", minArgs: 1, maxArgs: 3 },
  toYearWeek: { clickhouseName: "toYearWeek", minArgs: 1, maxArgs: 3 },
  date_add: { clickhouseName: "date_add", minArgs: 3, maxArgs: 3 },
  date_diff: { clickhouseName: "date_diff", minArgs: 3, maxArgs: 4 },
  date_sub: { clickhouseName: "date_sub", minArgs: 3, maxArgs: 3 },
  date_trunc: { clickhouseName: "date_trunc", minArgs: 2, maxArgs: 3 },
  dateDiff: { clickhouseName: "dateDiff", minArgs: 3, maxArgs: 4 },
  dateAdd: { clickhouseName: "dateAdd", minArgs: 3, maxArgs: 3 },
  dateSub: { clickhouseName: "dateSub", minArgs: 3, maxArgs: 3 },
  dateTrunc: { clickhouseName: "dateTrunc", minArgs: 2, maxArgs: 3 },
  addSeconds: { clickhouseName: "addSeconds", minArgs: 2, maxArgs: 2 },
  addMinutes: { clickhouseName: "addMinutes", minArgs: 2, maxArgs: 2 },
  addHours: { clickhouseName: "addHours", minArgs: 2, maxArgs: 2 },
  addDays: { clickhouseName: "addDays", minArgs: 2, maxArgs: 2 },
  addWeeks: { clickhouseName: "addWeeks", minArgs: 2, maxArgs: 2 },
  addMonths: { clickhouseName: "addMonths", minArgs: 2, maxArgs: 2 },
  addQuarters: { clickhouseName: "addQuarters", minArgs: 2, maxArgs: 2 },
  addYears: { clickhouseName: "addYears", minArgs: 2, maxArgs: 2 },
  subtractSeconds: { clickhouseName: "subtractSeconds", minArgs: 2, maxArgs: 2 },
  subtractMinutes: { clickhouseName: "subtractMinutes", minArgs: 2, maxArgs: 2 },
  subtractHours: { clickhouseName: "subtractHours", minArgs: 2, maxArgs: 2 },
  subtractDays: { clickhouseName: "subtractDays", minArgs: 2, maxArgs: 2 },
  subtractWeeks: { clickhouseName: "subtractWeeks", minArgs: 2, maxArgs: 2 },
  subtractMonths: { clickhouseName: "subtractMonths", minArgs: 2, maxArgs: 2 },
  subtractQuarters: { clickhouseName: "subtractQuarters", minArgs: 2, maxArgs: 2 },
  subtractYears: { clickhouseName: "subtractYears", minArgs: 2, maxArgs: 2 },
  toTimeZone: { clickhouseName: "toTimeZone", minArgs: 2, maxArgs: 2 },
  formatDateTime: { clickhouseName: "formatDateTime", minArgs: 2, maxArgs: 3 },
  parseDateTime: { clickhouseName: "parseDateTime", minArgs: 2, maxArgs: 3 },
  parseDateTimeBestEffort: { clickhouseName: "parseDateTimeBestEffort", minArgs: 1, maxArgs: 2, tzAware: true },
  parseDateTimeBestEffortOrNull: { clickhouseName: "parseDateTimeBestEffortOrNull", minArgs: 1, maxArgs: 2, tzAware: true },
  parseDateTimeBestEffortOrZero: { clickhouseName: "parseDateTimeBestEffortOrZero", minArgs: 1, maxArgs: 2, tzAware: true },
  parseDateTime64BestEffort: { clickhouseName: "parseDateTime64BestEffort", minArgs: 1, maxArgs: 3, tzAware: true },
  parseDateTime64BestEffortOrNull: { clickhouseName: "parseDateTime64BestEffortOrNull", minArgs: 1, maxArgs: 3, tzAware: true },
  parseDateTime64BestEffortOrZero: { clickhouseName: "parseDateTime64BestEffortOrZero", minArgs: 1, maxArgs: 3, tzAware: true },

  // Interval functions
  toIntervalSecond: { clickhouseName: "toIntervalSecond", minArgs: 1, maxArgs: 1 },
  toIntervalMinute: { clickhouseName: "toIntervalMinute", minArgs: 1, maxArgs: 1 },
  toIntervalHour: { clickhouseName: "toIntervalHour", minArgs: 1, maxArgs: 1 },
  toIntervalDay: { clickhouseName: "toIntervalDay", minArgs: 1, maxArgs: 1 },
  toIntervalWeek: { clickhouseName: "toIntervalWeek", minArgs: 1, maxArgs: 1 },
  toIntervalMonth: { clickhouseName: "toIntervalMonth", minArgs: 1, maxArgs: 1 },
  toIntervalQuarter: { clickhouseName: "toIntervalQuarter", minArgs: 1, maxArgs: 1 },
  toIntervalYear: { clickhouseName: "toIntervalYear", minArgs: 1, maxArgs: 1 },

  // Array functions
  array: { clickhouseName: "array", minArgs: 0 },
  range: { clickhouseName: "range", minArgs: 1, maxArgs: 3 },
  arrayElement: { clickhouseName: "arrayElement", minArgs: 2, maxArgs: 2 },
  has: { clickhouseName: "has", minArgs: 2, maxArgs: 2 },
  hasAll: { clickhouseName: "hasAll", minArgs: 2, maxArgs: 2 },
  hasAny: { clickhouseName: "hasAny", minArgs: 2, maxArgs: 2 },
  hasSubstr: { clickhouseName: "hasSubstr", minArgs: 2, maxArgs: 2 },
  indexOf: { clickhouseName: "indexOf", minArgs: 2, maxArgs: 2 },
  arrayCount: { clickhouseName: "arrayCount", minArgs: 1, maxArgs: 2 },
  countEqual: { clickhouseName: "countEqual", minArgs: 2, maxArgs: 2 },
  arrayEnumerate: { clickhouseName: "arrayEnumerate", minArgs: 1, maxArgs: 1 },
  arrayEnumerateDense: { clickhouseName: "arrayEnumerateDense", minArgs: 1 },
  arrayEnumerateUniq: { clickhouseName: "arrayEnumerateUniq", minArgs: 1 },
  arrayEnumerateUniqRanked: { clickhouseName: "arrayEnumerateUniqRanked", minArgs: 1 },
  arrayPopBack: { clickhouseName: "arrayPopBack", minArgs: 1, maxArgs: 1 },
  arrayPopFront: { clickhouseName: "arrayPopFront", minArgs: 1, maxArgs: 1 },
  arrayPushBack: { clickhouseName: "arrayPushBack", minArgs: 2, maxArgs: 2 },
  arrayPushFront: { clickhouseName: "arrayPushFront", minArgs: 2, maxArgs: 2 },
  arrayResize: { clickhouseName: "arrayResize", minArgs: 2, maxArgs: 3 },
  arraySlice: { clickhouseName: "arraySlice", minArgs: 2, maxArgs: 3 },
  arraySort: { clickhouseName: "arraySort", minArgs: 1, maxArgs: 2 },
  arrayPartialSort: { clickhouseName: "arrayPartialSort", minArgs: 2, maxArgs: 3 },
  arrayReverseSort: { clickhouseName: "arrayReverseSort", minArgs: 1, maxArgs: 2 },
  arrayPartialReverseSort: { clickhouseName: "arrayPartialReverseSort", minArgs: 2, maxArgs: 3 },
  arrayShuffle: { clickhouseName: "arrayShuffle", minArgs: 1, maxArgs: 2 },
  arrayUniq: { clickhouseName: "arrayUniq", minArgs: 1 },
  arrayJoin: { clickhouseName: "arrayJoin", minArgs: 1, maxArgs: 1 },
  arrayDifference: { clickhouseName: "arrayDifference", minArgs: 1, maxArgs: 1 },
  arrayDistinct: { clickhouseName: "arrayDistinct", minArgs: 1, maxArgs: 1 },
  arrayIntersect: { clickhouseName: "arrayIntersect", minArgs: 1 },
  arrayReduce: { clickhouseName: "arrayReduce", minArgs: 2 },
  arrayReverse: { clickhouseName: "arrayReverse", minArgs: 1, maxArgs: 1 },
  arrayFlatten: { clickhouseName: "arrayFlatten", minArgs: 1, maxArgs: 1 },
  arrayCompact: { clickhouseName: "arrayCompact", minArgs: 1, maxArgs: 1 },
  arrayZip: { clickhouseName: "arrayZip", minArgs: 1 },
  arrayMap: { clickhouseName: "arrayMap", minArgs: 2, maxArgs: 2 },
  arrayFilter: { clickhouseName: "arrayFilter", minArgs: 2, maxArgs: 2 },
  arrayFill: { clickhouseName: "arrayFill", minArgs: 2, maxArgs: 2 },
  arrayReverseFill: { clickhouseName: "arrayReverseFill", minArgs: 2, maxArgs: 2 },
  arraySplit: { clickhouseName: "arraySplit", minArgs: 2, maxArgs: 2 },
  arrayReverseSplit: { clickhouseName: "arrayReverseSplit", minArgs: 2, maxArgs: 2 },
  arrayExists: { clickhouseName: "arrayExists", minArgs: 1, maxArgs: 2 },
  arrayAll: { clickhouseName: "arrayAll", minArgs: 1, maxArgs: 2 },
  arrayFirst: { clickhouseName: "arrayFirst", minArgs: 1, maxArgs: 2 },
  arrayLast: { clickhouseName: "arrayLast", minArgs: 1, maxArgs: 2 },
  arrayFirstIndex: { clickhouseName: "arrayFirstIndex", minArgs: 1, maxArgs: 2 },
  arrayLastIndex: { clickhouseName: "arrayLastIndex", minArgs: 1, maxArgs: 2 },
  arrayMin: { clickhouseName: "arrayMin", minArgs: 1, maxArgs: 2 },
  arrayMax: { clickhouseName: "arrayMax", minArgs: 1, maxArgs: 2 },
  arraySum: { clickhouseName: "arraySum", minArgs: 1, maxArgs: 2 },
  arrayAvg: { clickhouseName: "arrayAvg", minArgs: 1, maxArgs: 2 },
  arrayCumSum: { clickhouseName: "arrayCumSum", minArgs: 1, maxArgs: 2 },
  arrayCumSumNonNegative: { clickhouseName: "arrayCumSumNonNegative", minArgs: 1, maxArgs: 2 },
  arrayProduct: { clickhouseName: "arrayProduct", minArgs: 1, maxArgs: 1 },

  // JSON functions
  JSONHas: { clickhouseName: "JSONHas", minArgs: 1 },
  JSONLength: { clickhouseName: "JSONLength", minArgs: 1 },
  JSONType: { clickhouseName: "JSONType", minArgs: 1 },
  JSONExtractUInt: { clickhouseName: "JSONExtractUInt", minArgs: 1 },
  JSONExtractInt: { clickhouseName: "JSONExtractInt", minArgs: 1 },
  JSONExtractFloat: { clickhouseName: "JSONExtractFloat", minArgs: 1 },
  JSONExtractBool: { clickhouseName: "JSONExtractBool", minArgs: 1 },
  JSONExtractString: { clickhouseName: "JSONExtractString", minArgs: 1 },
  JSONExtract: { clickhouseName: "JSONExtract", minArgs: 2 },
  JSONExtractRaw: { clickhouseName: "JSONExtractRaw", minArgs: 1 },
  JSONExtractArrayRaw: { clickhouseName: "JSONExtractArrayRaw", minArgs: 1 },
  JSONExtractKeysAndValues: { clickhouseName: "JSONExtractKeysAndValues", minArgs: 2, maxArgs: 2 },
  JSONExtractKeys: { clickhouseName: "JSONExtractKeys", minArgs: 1 },
  toJSONString: { clickhouseName: "toJSONString", minArgs: 1, maxArgs: 1 },

  // Tuple functions
  tuple: { clickhouseName: "tuple", minArgs: 0 },
  tupleElement: { clickhouseName: "tupleElement", minArgs: 2, maxArgs: 3 },
  untuple: { clickhouseName: "untuple", minArgs: 1, maxArgs: 1 },

  // Map functions
  map: { clickhouseName: "map", minArgs: 0 },
  mapFromArrays: { clickhouseName: "mapFromArrays", minArgs: 2, maxArgs: 2 },
  mapContains: { clickhouseName: "mapContains", minArgs: 2, maxArgs: 2 },
  mapKeys: { clickhouseName: "mapKeys", minArgs: 1, maxArgs: 1 },
  mapValues: { clickhouseName: "mapValues", minArgs: 1, maxArgs: 1 },

  // Hash functions
  MD5: { clickhouseName: "MD5", minArgs: 1, maxArgs: 1 },
  SHA1: { clickhouseName: "SHA1", minArgs: 1, maxArgs: 1 },
  SHA224: { clickhouseName: "SHA224", minArgs: 1, maxArgs: 1 },
  SHA256: { clickhouseName: "SHA256", minArgs: 1, maxArgs: 1 },
  SHA384: { clickhouseName: "SHA384", minArgs: 1, maxArgs: 1 },
  SHA512: { clickhouseName: "SHA512", minArgs: 1, maxArgs: 1 },
  sipHash64: { clickhouseName: "sipHash64", minArgs: 1 },
  sipHash128: { clickhouseName: "sipHash128", minArgs: 1 },
  cityHash64: { clickhouseName: "cityHash64", minArgs: 1 },
  intHash32: { clickhouseName: "intHash32", minArgs: 1, maxArgs: 1 },
  intHash64: { clickhouseName: "intHash64", minArgs: 1, maxArgs: 1 },
  farmHash64: { clickhouseName: "farmHash64", minArgs: 1 },
  farmFingerprint64: { clickhouseName: "farmFingerprint64", minArgs: 1 },
  xxHash32: { clickhouseName: "xxHash32", minArgs: 1 },
  xxHash64: { clickhouseName: "xxHash64", minArgs: 1 },
  murmurHash2_32: { clickhouseName: "murmurHash2_32", minArgs: 1 },
  murmurHash2_64: { clickhouseName: "murmurHash2_64", minArgs: 1 },
  murmurHash3_32: { clickhouseName: "murmurHash3_32", minArgs: 1 },
  murmurHash3_64: { clickhouseName: "murmurHash3_64", minArgs: 1 },
  murmurHash3_128: { clickhouseName: "murmurHash3_128", minArgs: 1 },
  hex: { clickhouseName: "hex", minArgs: 1, maxArgs: 1 },
  unhex: { clickhouseName: "unhex", minArgs: 1, maxArgs: 1 },

  // URL functions
  protocol: { clickhouseName: "protocol", minArgs: 1, maxArgs: 1 },
  domain: { clickhouseName: "domain", minArgs: 1, maxArgs: 1 },
  domainWithoutWWW: { clickhouseName: "domainWithoutWWW", minArgs: 1, maxArgs: 1 },
  topLevelDomain: { clickhouseName: "topLevelDomain", minArgs: 1, maxArgs: 1 },
  firstSignificantSubdomain: { clickhouseName: "firstSignificantSubdomain", minArgs: 1, maxArgs: 1 },
  cutToFirstSignificantSubdomain: { clickhouseName: "cutToFirstSignificantSubdomain", minArgs: 1, maxArgs: 1 },
  cutToFirstSignificantSubdomainWithWWW: { clickhouseName: "cutToFirstSignificantSubdomainWithWWW", minArgs: 1, maxArgs: 1 },
  port: { clickhouseName: "port", minArgs: 1, maxArgs: 2 },
  path: { clickhouseName: "path", minArgs: 1, maxArgs: 1 },
  pathFull: { clickhouseName: "pathFull", minArgs: 1, maxArgs: 1 },
  queryString: { clickhouseName: "queryString", minArgs: 1, maxArgs: 1 },
  fragment: { clickhouseName: "fragment", minArgs: 1, maxArgs: 1 },
  extractURLParameter: { clickhouseName: "extractURLParameter", minArgs: 2, maxArgs: 2 },
  extractURLParameters: { clickhouseName: "extractURLParameters", minArgs: 1, maxArgs: 1 },
  encodeURLComponent: { clickhouseName: "encodeURLComponent", minArgs: 1, maxArgs: 1 },
  decodeURLComponent: { clickhouseName: "decodeURLComponent", minArgs: 1, maxArgs: 1 },

  // UUID functions
  generateUUIDv4: { clickhouseName: "generateUUIDv4", minArgs: 0, maxArgs: 0 },
  UUIDStringToNum: { clickhouseName: "UUIDStringToNum", minArgs: 1, maxArgs: 1 },
  UUIDNumToString: { clickhouseName: "UUIDNumToString", minArgs: 1, maxArgs: 1 },

  // Other functions
  isFinite: { clickhouseName: "isFinite", minArgs: 1, maxArgs: 1 },
  isInfinite: { clickhouseName: "isInfinite", minArgs: 1, maxArgs: 1 },
  ifNotFinite: { clickhouseName: "ifNotFinite", minArgs: 1, maxArgs: 1 },
  isNaN: { clickhouseName: "isNaN", minArgs: 1, maxArgs: 1 },
  bar: { clickhouseName: "bar", minArgs: 4, maxArgs: 4 },
  transform: { clickhouseName: "transform", minArgs: 3, maxArgs: 4 },
  formatReadableDecimalSize: { clickhouseName: "formatReadableDecimalSize", minArgs: 1, maxArgs: 1 },
  formatReadableSize: { clickhouseName: "formatReadableSize", minArgs: 1, maxArgs: 1 },
  formatReadableQuantity: { clickhouseName: "formatReadableQuantity", minArgs: 1, maxArgs: 1 },
  formatReadableTimeDelta: { clickhouseName: "formatReadableTimeDelta", minArgs: 1, maxArgs: 2 },
  least: { clickhouseName: "least", minArgs: 2, maxArgs: 2, caseSensitive: false },
  greatest: { clickhouseName: "greatest", minArgs: 2, maxArgs: 2, caseSensitive: false },
  min2: { clickhouseName: "min2", minArgs: 2, maxArgs: 2 },
  max2: { clickhouseName: "max2", minArgs: 2, maxArgs: 2 },
  runningDifference: { clickhouseName: "runningDifference", minArgs: 1, maxArgs: 1 },
  runningDifferenceStartingWithFirstValue: { clickhouseName: "runningDifferenceStartingWithFirstValue", minArgs: 1, maxArgs: 1 },
  neighbor: { clickhouseName: "neighbor", minArgs: 2, maxArgs: 3 },

  // Window functions
  rank: { clickhouseName: "rank", minArgs: 0, maxArgs: 0 },
  dense_rank: { clickhouseName: "dense_rank", minArgs: 0, maxArgs: 0 },
  row_number: { clickhouseName: "row_number", minArgs: 0, maxArgs: 0 },
  first_value: { clickhouseName: "first_value", minArgs: 1, maxArgs: 1 },
  last_value: { clickhouseName: "last_value", minArgs: 1, maxArgs: 1 },
  nth_value: { clickhouseName: "nth_value", minArgs: 2, maxArgs: 2 },
  lagInFrame: { clickhouseName: "lagInFrame", minArgs: 1, maxArgs: 3 },
  leadInFrame: { clickhouseName: "leadInFrame", minArgs: 1, maxArgs: 3 },
  lag: { clickhouseName: "lagInFrame", minArgs: 1, maxArgs: 3 },
  lead: { clickhouseName: "leadInFrame", minArgs: 1, maxArgs: 3 },
};

/**
 * Aggregate functions available in TRQL
 * Port of HOGQL_AGGREGATIONS from aggregations.py
 */
export const TRQL_AGGREGATIONS: Record<string, TRQLFunctionMeta> = {
  // Standard aggregate functions
  count: { clickhouseName: "count", minArgs: 0, maxArgs: 1, aggregate: true, caseSensitive: false },
  countIf: { clickhouseName: "countIf", minArgs: 1, maxArgs: 2, aggregate: true },
  countDistinct: { clickhouseName: "countDistinct", minArgs: 1, maxArgs: 1, aggregate: true },
  countDistinctIf: { clickhouseName: "countDistinctIf", minArgs: 1, maxArgs: 2, aggregate: true },
  min: { clickhouseName: "min", minArgs: 1, maxArgs: 1, aggregate: true, caseSensitive: false },
  minIf: { clickhouseName: "minIf", minArgs: 2, maxArgs: 2, aggregate: true },
  max: { clickhouseName: "max", minArgs: 1, maxArgs: 1, aggregate: true, caseSensitive: false },
  maxIf: { clickhouseName: "maxIf", minArgs: 2, maxArgs: 2, aggregate: true },
  sum: { clickhouseName: "sum", minArgs: 1, maxArgs: 1, aggregate: true, caseSensitive: false },
  sumIf: { clickhouseName: "sumIf", minArgs: 2, maxArgs: 2, aggregate: true },
  avg: { clickhouseName: "avg", minArgs: 1, maxArgs: 1, aggregate: true, caseSensitive: false },
  avgIf: { clickhouseName: "avgIf", minArgs: 2, maxArgs: 2, aggregate: true },
  any: { clickhouseName: "any", minArgs: 1, maxArgs: 1, aggregate: true },
  anyIf: { clickhouseName: "anyIf", minArgs: 2, maxArgs: 2, aggregate: true },
  anyLast: { clickhouseName: "anyLast", minArgs: 1, maxArgs: 1, aggregate: true },
  anyLastIf: { clickhouseName: "anyLastIf", minArgs: 2, maxArgs: 2, aggregate: true },
  anyHeavy: { clickhouseName: "anyHeavy", minArgs: 1, maxArgs: 1, aggregate: true },
  anyHeavyIf: { clickhouseName: "anyHeavyIf", minArgs: 2, maxArgs: 2, aggregate: true },
  argMin: { clickhouseName: "argMin", minArgs: 2, maxArgs: 2, aggregate: true },
  argMinIf: { clickhouseName: "argMinIf", minArgs: 3, maxArgs: 3, aggregate: true },
  argMax: { clickhouseName: "argMax", minArgs: 2, maxArgs: 2, aggregate: true },
  argMaxIf: { clickhouseName: "argMaxIf", minArgs: 3, maxArgs: 3, aggregate: true },
  stddevPop: { clickhouseName: "stddevPop", minArgs: 1, maxArgs: 1, aggregate: true },
  stddevSamp: { clickhouseName: "stddevSamp", minArgs: 1, maxArgs: 1, aggregate: true },
  varPop: { clickhouseName: "varPop", minArgs: 1, maxArgs: 1, aggregate: true },
  varSamp: { clickhouseName: "varSamp", minArgs: 1, maxArgs: 1, aggregate: true },
  covarPop: { clickhouseName: "covarPop", minArgs: 2, maxArgs: 2, aggregate: true },
  covarSamp: { clickhouseName: "covarSamp", minArgs: 2, maxArgs: 2, aggregate: true },
  corr: { clickhouseName: "corr", minArgs: 2, maxArgs: 2, aggregate: true },

  // Array aggregations
  groupArray: { clickhouseName: "groupArray", minArgs: 1, maxArgs: 1, aggregate: true },
  groupArrayIf: { clickhouseName: "groupArrayIf", minArgs: 2, maxArgs: 2, aggregate: true },
  groupUniqArray: { clickhouseName: "groupUniqArray", minArgs: 1, maxArgs: 1, aggregate: true },
  groupUniqArrayIf: { clickhouseName: "groupUniqArrayIf", minArgs: 2, maxArgs: 2, aggregate: true },
  groupArrayInsertAt: { clickhouseName: "groupArrayInsertAt", minArgs: 2, maxArgs: 2, aggregate: true },
  groupArrayMovingAvg: { clickhouseName: "groupArrayMovingAvg", minArgs: 1, maxArgs: 1, aggregate: true },
  groupArrayMovingSum: { clickhouseName: "groupArrayMovingSum", minArgs: 1, maxArgs: 1, aggregate: true },
  groupArraySample: { clickhouseName: "groupArraySample", minArgs: 1, maxArgs: 1, minParams: 1, maxParams: 2, aggregate: true },
  array_agg: { clickhouseName: "groupArray", minArgs: 1, maxArgs: 1, aggregate: true },

  // Bitmap aggregations
  groupBitmap: { clickhouseName: "groupBitmap", minArgs: 1, maxArgs: 1, aggregate: true },
  groupBitmapAnd: { clickhouseName: "groupBitmapAnd", minArgs: 1, maxArgs: 1, aggregate: true },
  groupBitmapOr: { clickhouseName: "groupBitmapOr", minArgs: 1, maxArgs: 1, aggregate: true },
  groupBitmapXor: { clickhouseName: "groupBitmapXor", minArgs: 1, maxArgs: 1, aggregate: true },

  // Uniq functions
  uniq: { clickhouseName: "uniq", minArgs: 1, aggregate: true },
  uniqIf: { clickhouseName: "uniqIf", minArgs: 2, aggregate: true },
  uniqExact: { clickhouseName: "uniqExact", minArgs: 1, aggregate: true },
  uniqExactIf: { clickhouseName: "uniqExactIf", minArgs: 2, aggregate: true },
  uniqHLL12: { clickhouseName: "uniqHLL12", minArgs: 1, aggregate: true },
  uniqTheta: { clickhouseName: "uniqTheta", minArgs: 1, aggregate: true },

  // Quantile functions
  median: { clickhouseName: "median", minArgs: 1, maxArgs: 1, aggregate: true },
  medianIf: { clickhouseName: "medianIf", minArgs: 2, maxArgs: 2, aggregate: true },
  medianExact: { clickhouseName: "medianExact", minArgs: 1, maxArgs: 1, aggregate: true },
  quantile: { clickhouseName: "quantile", minArgs: 1, maxArgs: 1, minParams: 1, maxParams: 1, aggregate: true },
  quantileIf: { clickhouseName: "quantileIf", minArgs: 2, maxArgs: 2, minParams: 1, maxParams: 1, aggregate: true },
  quantiles: { clickhouseName: "quantiles", minArgs: 1, aggregate: true },

  // Statistical functions
  simpleLinearRegression: { clickhouseName: "simpleLinearRegression", minArgs: 2, maxArgs: 2, aggregate: true },
  contingency: { clickhouseName: "contingency", minArgs: 2, maxArgs: 2, aggregate: true },
  cramersV: { clickhouseName: "cramersV", minArgs: 2, maxArgs: 2, aggregate: true },
  theilsU: { clickhouseName: "theilsU", minArgs: 2, maxArgs: 2, aggregate: true },

  // Sum/Map variants
  sumMap: { clickhouseName: "sumMap", minArgs: 1, maxArgs: 2, aggregate: true },
  minMap: { clickhouseName: "minMap", minArgs: 1, maxArgs: 2, aggregate: true },
  maxMap: { clickhouseName: "maxMap", minArgs: 1, maxArgs: 2, aggregate: true },

  // TopK
  topK: { clickhouseName: "topK", minArgs: 1, maxArgs: 1, minParams: 1, maxParams: 1, aggregate: true },

  // Funnel
  windowFunnel: { clickhouseName: "windowFunnel", minArgs: 1, maxArgs: 99, aggregate: true },
};

/**
 * Find a function in the TRQL functions map
 * Supports case-insensitive lookup for non-case-sensitive functions
 */
function findFunction(
  name: string,
  functions: Record<string, TRQLFunctionMeta>
): TRQLFunctionMeta | undefined {
  const func = functions[name];
  if (func !== undefined) {
    return func;
  }

  const lowerFunc = functions[name.toLowerCase()];
  if (lowerFunc === undefined) {
    return undefined;
  }

  // If we haven't found a function with the case preserved, but we have found it in lowercase,
  // then the function names are different case-wise only.
  if (lowerFunc.caseSensitive) {
    return undefined;
  }

  return lowerFunc;
}

/**
 * Find a TRQL aggregation function by name
 */
export function findTRQLAggregation(name: string): TRQLFunctionMeta | undefined {
  return findFunction(name, TRQL_AGGREGATIONS);
}

/**
 * Find a TRQL function by name
 */
export function findTRQLFunction(name: string): TRQLFunctionMeta | undefined {
  return findFunction(name, TRQL_CLICKHOUSE_FUNCTIONS);
}

/**
 * Get all exposed function names (for autocomplete, suggestions, etc.)
 */
export function getAllExposedFunctionNames(): string[] {
  const functionNames = Object.keys(TRQL_CLICKHOUSE_FUNCTIONS).filter((name) => !name.startsWith("_"));
  const aggregationNames = Object.keys(TRQL_AGGREGATIONS).filter((name) => !name.startsWith("_"));
  return [...functionNames, ...aggregationNames];
}

/**
 * Validate function arguments
 */
export function validateFunctionArgs(
  args: unknown[],
  minArgs: number,
  maxArgs: number | undefined,
  functionName: string,
  options: {
    functionTerm?: string;
    argumentTerm?: string;
  } = {}
): void {
  const { functionTerm = "function", argumentTerm = "argument" } = options;

  const tooFew = args.length < minArgs;
  const tooMany = maxArgs !== undefined && args.length > maxArgs;

  if (minArgs === maxArgs && (tooFew || tooMany)) {
    throw new Error(
      `${functionTerm.charAt(0).toUpperCase() + functionTerm.slice(1)} '${functionName}' expects ${minArgs} ${argumentTerm}${minArgs !== 1 ? "s" : ""}, found ${args.length}`
    );
  }
  if (tooFew) {
    throw new Error(
      `${functionTerm.charAt(0).toUpperCase() + functionTerm.slice(1)} '${functionName}' expects at least ${minArgs} ${argumentTerm}${minArgs !== 1 ? "s" : ""}, found ${args.length}`
    );
  }
  if (tooMany) {
    throw new Error(
      `${functionTerm.charAt(0).toUpperCase() + functionTerm.slice(1)} '${functionName}' expects at most ${maxArgs} ${argumentTerm}${maxArgs !== 1 ? "s" : ""}, found ${args.length}`
    );
  }
}

