/* eslint-disable */
import Long from "long";
import _m0 from "protobufjs/minimal";
import { AnyValue, InstrumentationScope, KeyValue } from "../../common/v1/common";
import { Resource } from "../../resource/v1/resource";

export const protobufPackage = "opentelemetry.proto.logs.v1";

/** Possible values for LogRecord.SeverityNumber. */
export enum SeverityNumber {
  /** UNSPECIFIED - UNSPECIFIED is the default SeverityNumber, it MUST NOT be used. */
  UNSPECIFIED = 0,
  TRACE = 1,
  TRACE2 = 2,
  TRACE3 = 3,
  TRACE4 = 4,
  DEBUG = 5,
  DEBUG2 = 6,
  DEBUG3 = 7,
  DEBUG4 = 8,
  INFO = 9,
  INFO2 = 10,
  INFO3 = 11,
  INFO4 = 12,
  WARN = 13,
  WARN2 = 14,
  WARN3 = 15,
  WARN4 = 16,
  ERROR = 17,
  ERROR2 = 18,
  ERROR3 = 19,
  ERROR4 = 20,
  FATAL = 21,
  FATAL2 = 22,
  FATAL3 = 23,
  FATAL4 = 24,
  UNRECOGNIZED = -1,
}

export function severityNumberFromJSON(object: any): SeverityNumber {
  switch (object) {
    case 0:
    case "SEVERITY_NUMBER_UNSPECIFIED":
      return SeverityNumber.UNSPECIFIED;
    case 1:
    case "SEVERITY_NUMBER_TRACE":
      return SeverityNumber.TRACE;
    case 2:
    case "SEVERITY_NUMBER_TRACE2":
      return SeverityNumber.TRACE2;
    case 3:
    case "SEVERITY_NUMBER_TRACE3":
      return SeverityNumber.TRACE3;
    case 4:
    case "SEVERITY_NUMBER_TRACE4":
      return SeverityNumber.TRACE4;
    case 5:
    case "SEVERITY_NUMBER_DEBUG":
      return SeverityNumber.DEBUG;
    case 6:
    case "SEVERITY_NUMBER_DEBUG2":
      return SeverityNumber.DEBUG2;
    case 7:
    case "SEVERITY_NUMBER_DEBUG3":
      return SeverityNumber.DEBUG3;
    case 8:
    case "SEVERITY_NUMBER_DEBUG4":
      return SeverityNumber.DEBUG4;
    case 9:
    case "SEVERITY_NUMBER_INFO":
      return SeverityNumber.INFO;
    case 10:
    case "SEVERITY_NUMBER_INFO2":
      return SeverityNumber.INFO2;
    case 11:
    case "SEVERITY_NUMBER_INFO3":
      return SeverityNumber.INFO3;
    case 12:
    case "SEVERITY_NUMBER_INFO4":
      return SeverityNumber.INFO4;
    case 13:
    case "SEVERITY_NUMBER_WARN":
      return SeverityNumber.WARN;
    case 14:
    case "SEVERITY_NUMBER_WARN2":
      return SeverityNumber.WARN2;
    case 15:
    case "SEVERITY_NUMBER_WARN3":
      return SeverityNumber.WARN3;
    case 16:
    case "SEVERITY_NUMBER_WARN4":
      return SeverityNumber.WARN4;
    case 17:
    case "SEVERITY_NUMBER_ERROR":
      return SeverityNumber.ERROR;
    case 18:
    case "SEVERITY_NUMBER_ERROR2":
      return SeverityNumber.ERROR2;
    case 19:
    case "SEVERITY_NUMBER_ERROR3":
      return SeverityNumber.ERROR3;
    case 20:
    case "SEVERITY_NUMBER_ERROR4":
      return SeverityNumber.ERROR4;
    case 21:
    case "SEVERITY_NUMBER_FATAL":
      return SeverityNumber.FATAL;
    case 22:
    case "SEVERITY_NUMBER_FATAL2":
      return SeverityNumber.FATAL2;
    case 23:
    case "SEVERITY_NUMBER_FATAL3":
      return SeverityNumber.FATAL3;
    case 24:
    case "SEVERITY_NUMBER_FATAL4":
      return SeverityNumber.FATAL4;
    case -1:
    case "UNRECOGNIZED":
    default:
      return SeverityNumber.UNRECOGNIZED;
  }
}

export function severityNumberToJSON(object: SeverityNumber): string {
  switch (object) {
    case SeverityNumber.UNSPECIFIED:
      return "SEVERITY_NUMBER_UNSPECIFIED";
    case SeverityNumber.TRACE:
      return "SEVERITY_NUMBER_TRACE";
    case SeverityNumber.TRACE2:
      return "SEVERITY_NUMBER_TRACE2";
    case SeverityNumber.TRACE3:
      return "SEVERITY_NUMBER_TRACE3";
    case SeverityNumber.TRACE4:
      return "SEVERITY_NUMBER_TRACE4";
    case SeverityNumber.DEBUG:
      return "SEVERITY_NUMBER_DEBUG";
    case SeverityNumber.DEBUG2:
      return "SEVERITY_NUMBER_DEBUG2";
    case SeverityNumber.DEBUG3:
      return "SEVERITY_NUMBER_DEBUG3";
    case SeverityNumber.DEBUG4:
      return "SEVERITY_NUMBER_DEBUG4";
    case SeverityNumber.INFO:
      return "SEVERITY_NUMBER_INFO";
    case SeverityNumber.INFO2:
      return "SEVERITY_NUMBER_INFO2";
    case SeverityNumber.INFO3:
      return "SEVERITY_NUMBER_INFO3";
    case SeverityNumber.INFO4:
      return "SEVERITY_NUMBER_INFO4";
    case SeverityNumber.WARN:
      return "SEVERITY_NUMBER_WARN";
    case SeverityNumber.WARN2:
      return "SEVERITY_NUMBER_WARN2";
    case SeverityNumber.WARN3:
      return "SEVERITY_NUMBER_WARN3";
    case SeverityNumber.WARN4:
      return "SEVERITY_NUMBER_WARN4";
    case SeverityNumber.ERROR:
      return "SEVERITY_NUMBER_ERROR";
    case SeverityNumber.ERROR2:
      return "SEVERITY_NUMBER_ERROR2";
    case SeverityNumber.ERROR3:
      return "SEVERITY_NUMBER_ERROR3";
    case SeverityNumber.ERROR4:
      return "SEVERITY_NUMBER_ERROR4";
    case SeverityNumber.FATAL:
      return "SEVERITY_NUMBER_FATAL";
    case SeverityNumber.FATAL2:
      return "SEVERITY_NUMBER_FATAL2";
    case SeverityNumber.FATAL3:
      return "SEVERITY_NUMBER_FATAL3";
    case SeverityNumber.FATAL4:
      return "SEVERITY_NUMBER_FATAL4";
    case SeverityNumber.UNRECOGNIZED:
    default:
      return "UNRECOGNIZED";
  }
}

/**
 * LogRecordFlags represents constants used to interpret the
 * LogRecord.flags field, which is protobuf 'fixed32' type and is to
 * be used as bit-fields. Each non-zero value defined in this enum is
 * a bit-mask.  To extract the bit-field, for example, use an
 * expression like:
 *
 *   (logRecord.flags & LOG_RECORD_FLAGS_TRACE_FLAGS_MASK)
 */
export enum LogRecordFlags {
  /**
   * DO_NOT_USE - The zero value for the enum. Should not be used for comparisons.
   * Instead use bitwise "and" with the appropriate mask as shown above.
   */
  DO_NOT_USE = 0,
  /** TRACE_FLAGS_MASK - Bits 0-7 are used for trace flags. */
  TRACE_FLAGS_MASK = 255,
  UNRECOGNIZED = -1,
}

export function logRecordFlagsFromJSON(object: any): LogRecordFlags {
  switch (object) {
    case 0:
    case "LOG_RECORD_FLAGS_DO_NOT_USE":
      return LogRecordFlags.DO_NOT_USE;
    case 255:
    case "LOG_RECORD_FLAGS_TRACE_FLAGS_MASK":
      return LogRecordFlags.TRACE_FLAGS_MASK;
    case -1:
    case "UNRECOGNIZED":
    default:
      return LogRecordFlags.UNRECOGNIZED;
  }
}

export function logRecordFlagsToJSON(object: LogRecordFlags): string {
  switch (object) {
    case LogRecordFlags.DO_NOT_USE:
      return "LOG_RECORD_FLAGS_DO_NOT_USE";
    case LogRecordFlags.TRACE_FLAGS_MASK:
      return "LOG_RECORD_FLAGS_TRACE_FLAGS_MASK";
    case LogRecordFlags.UNRECOGNIZED:
    default:
      return "UNRECOGNIZED";
  }
}

/**
 * LogsData represents the logs data that can be stored in a persistent storage,
 * OR can be embedded by other protocols that transfer OTLP logs data but do not
 * implement the OTLP protocol.
 *
 * The main difference between this message and collector protocol is that
 * in this message there will not be any "control" or "metadata" specific to
 * OTLP protocol.
 *
 * When new fields are added into this message, the OTLP request MUST be updated
 * as well.
 */
export interface LogsData {
  /**
   * An array of ResourceLogs.
   * For data coming from a single resource this array will typically contain
   * one element. Intermediary nodes that receive data from multiple origins
   * typically batch the data before forwarding further and in that case this
   * array will contain multiple elements.
   */
  resourceLogs: ResourceLogs[];
}

/** A collection of ScopeLogs from a Resource. */
export interface ResourceLogs {
  /**
   * The resource for the logs in this message.
   * If this field is not set then resource info is unknown.
   */
  resource:
    | Resource
    | undefined;
  /** A list of ScopeLogs that originate from a resource. */
  scopeLogs: ScopeLogs[];
  /**
   * The Schema URL, if known. This is the identifier of the Schema that the resource data
   * is recorded in. To learn more about Schema URL see
   * https://opentelemetry.io/docs/specs/otel/schemas/#schema-url
   * This schema_url applies to the data in the "resource" field. It does not apply
   * to the data in the "scope_logs" field which have their own schema_url field.
   */
  schemaUrl: string;
}

/** A collection of Logs produced by a Scope. */
export interface ScopeLogs {
  /**
   * The instrumentation scope information for the logs in this message.
   * Semantically when InstrumentationScope isn't set, it is equivalent with
   * an empty instrumentation scope name (unknown).
   */
  scope:
    | InstrumentationScope
    | undefined;
  /** A list of log records. */
  logRecords: LogRecord[];
  /**
   * The Schema URL, if known. This is the identifier of the Schema that the log data
   * is recorded in. To learn more about Schema URL see
   * https://opentelemetry.io/docs/specs/otel/schemas/#schema-url
   * This schema_url applies to all logs in the "logs" field.
   */
  schemaUrl: string;
}

/**
 * A log record according to OpenTelemetry Log Data Model:
 * https://github.com/open-telemetry/oteps/blob/main/text/logs/0097-log-data-model.md
 */
export interface LogRecord {
  /**
   * time_unix_nano is the time when the event occurred.
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January 1970.
   * Value of 0 indicates unknown or missing timestamp.
   */
  timeUnixNano: bigint;
  /**
   * Time when the event was observed by the collection system.
   * For events that originate in OpenTelemetry (e.g. using OpenTelemetry Logging SDK)
   * this timestamp is typically set at the generation time and is equal to Timestamp.
   * For events originating externally and collected by OpenTelemetry (e.g. using
   * Collector) this is the time when OpenTelemetry's code observed the event measured
   * by the clock of the OpenTelemetry code. This field MUST be set once the event is
   * observed by OpenTelemetry.
   *
   * For converting OpenTelemetry log data to formats that support only one timestamp or
   * when receiving OpenTelemetry log data by recipients that support only one timestamp
   * internally the following logic is recommended:
   *   - Use time_unix_nano if it is present, otherwise use observed_time_unix_nano.
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January 1970.
   * Value of 0 indicates unknown or missing timestamp.
   */
  observedTimeUnixNano: bigint;
  /**
   * Numerical value of the severity, normalized to values described in Log Data Model.
   * [Optional].
   */
  severityNumber: SeverityNumber;
  /**
   * The severity text (also known as log level). The original string representation as
   * it is known at the source. [Optional].
   */
  severityText: string;
  /**
   * A value containing the body of the log record. Can be for example a human-readable
   * string message (including multi-line) describing the event in a free form or it can
   * be a structured data composed of arrays and maps of other values. [Optional].
   */
  body:
    | AnyValue
    | undefined;
  /**
   * Additional attributes that describe the specific event occurrence. [Optional].
   * Attribute keys MUST be unique (it is not allowed to have more than one
   * attribute with the same key).
   */
  attributes: KeyValue[];
  droppedAttributesCount: number;
  /**
   * Flags, a bit field. 8 least significant bits are the trace flags as
   * defined in W3C Trace Context specification. 24 most significant bits are reserved
   * and must be set to 0. Readers must not assume that 24 most significant bits
   * will be zero and must correctly mask the bits when reading 8-bit trace flag (use
   * flags & LOG_RECORD_FLAGS_TRACE_FLAGS_MASK). [Optional].
   */
  flags: number;
  /**
   * A unique identifier for a trace. All logs from the same trace share
   * the same `trace_id`. The ID is a 16-byte array. An ID with all zeroes OR
   * of length other than 16 bytes is considered invalid (empty string in OTLP/JSON
   * is zero-length and thus is also invalid).
   *
   * This field is optional.
   *
   * The receivers SHOULD assume that the log record is not associated with a
   * trace if any of the following is true:
   *   - the field is not present,
   *   - the field contains an invalid value.
   */
  traceId: Buffer;
  /**
   * A unique identifier for a span within a trace, assigned when the span
   * is created. The ID is an 8-byte array. An ID with all zeroes OR of length
   * other than 8 bytes is considered invalid (empty string in OTLP/JSON
   * is zero-length and thus is also invalid).
   *
   * This field is optional. If the sender specifies a valid span_id then it SHOULD also
   * specify a valid trace_id.
   *
   * The receivers SHOULD assume that the log record is not associated with a
   * span if any of the following is true:
   *   - the field is not present,
   *   - the field contains an invalid value.
   */
  spanId: Buffer;
}

function createBaseLogsData(): LogsData {
  return { resourceLogs: [] };
}

export const LogsData = {
  encode(message: LogsData, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.resourceLogs) {
      ResourceLogs.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): LogsData {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseLogsData();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.resourceLogs.push(ResourceLogs.decode(reader, reader.uint32()));
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): LogsData {
    return {
      resourceLogs: globalThis.Array.isArray(object?.resourceLogs)
        ? object.resourceLogs.map((e: any) => ResourceLogs.fromJSON(e))
        : [],
    };
  },

  toJSON(message: LogsData): unknown {
    const obj: any = {};
    if (message.resourceLogs?.length) {
      obj.resourceLogs = message.resourceLogs.map((e) => ResourceLogs.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<LogsData>, I>>(base?: I): LogsData {
    return LogsData.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<LogsData>, I>>(object: I): LogsData {
    const message = createBaseLogsData();
    message.resourceLogs = object.resourceLogs?.map((e) => ResourceLogs.fromPartial(e)) || [];
    return message;
  },
};

function createBaseResourceLogs(): ResourceLogs {
  return { resource: undefined, scopeLogs: [], schemaUrl: "" };
}

export const ResourceLogs = {
  encode(message: ResourceLogs, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.resource !== undefined) {
      Resource.encode(message.resource, writer.uint32(10).fork()).ldelim();
    }
    for (const v of message.scopeLogs) {
      ScopeLogs.encode(v!, writer.uint32(18).fork()).ldelim();
    }
    if (message.schemaUrl !== "") {
      writer.uint32(26).string(message.schemaUrl);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ResourceLogs {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseResourceLogs();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.resource = Resource.decode(reader, reader.uint32());
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.scopeLogs.push(ScopeLogs.decode(reader, reader.uint32()));
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.schemaUrl = reader.string();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ResourceLogs {
    return {
      resource: isSet(object.resource) ? Resource.fromJSON(object.resource) : undefined,
      scopeLogs: globalThis.Array.isArray(object?.scopeLogs)
        ? object.scopeLogs.map((e: any) => ScopeLogs.fromJSON(e))
        : [],
      schemaUrl: isSet(object.schemaUrl) ? globalThis.String(object.schemaUrl) : "",
    };
  },

  toJSON(message: ResourceLogs): unknown {
    const obj: any = {};
    if (message.resource !== undefined) {
      obj.resource = Resource.toJSON(message.resource);
    }
    if (message.scopeLogs?.length) {
      obj.scopeLogs = message.scopeLogs.map((e) => ScopeLogs.toJSON(e));
    }
    if (message.schemaUrl !== "") {
      obj.schemaUrl = message.schemaUrl;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ResourceLogs>, I>>(base?: I): ResourceLogs {
    return ResourceLogs.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ResourceLogs>, I>>(object: I): ResourceLogs {
    const message = createBaseResourceLogs();
    message.resource = (object.resource !== undefined && object.resource !== null)
      ? Resource.fromPartial(object.resource)
      : undefined;
    message.scopeLogs = object.scopeLogs?.map((e) => ScopeLogs.fromPartial(e)) || [];
    message.schemaUrl = object.schemaUrl ?? "";
    return message;
  },
};

function createBaseScopeLogs(): ScopeLogs {
  return { scope: undefined, logRecords: [], schemaUrl: "" };
}

export const ScopeLogs = {
  encode(message: ScopeLogs, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.scope !== undefined) {
      InstrumentationScope.encode(message.scope, writer.uint32(10).fork()).ldelim();
    }
    for (const v of message.logRecords) {
      LogRecord.encode(v!, writer.uint32(18).fork()).ldelim();
    }
    if (message.schemaUrl !== "") {
      writer.uint32(26).string(message.schemaUrl);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ScopeLogs {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseScopeLogs();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.scope = InstrumentationScope.decode(reader, reader.uint32());
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.logRecords.push(LogRecord.decode(reader, reader.uint32()));
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.schemaUrl = reader.string();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ScopeLogs {
    return {
      scope: isSet(object.scope) ? InstrumentationScope.fromJSON(object.scope) : undefined,
      logRecords: globalThis.Array.isArray(object?.logRecords)
        ? object.logRecords.map((e: any) => LogRecord.fromJSON(e))
        : [],
      schemaUrl: isSet(object.schemaUrl) ? globalThis.String(object.schemaUrl) : "",
    };
  },

  toJSON(message: ScopeLogs): unknown {
    const obj: any = {};
    if (message.scope !== undefined) {
      obj.scope = InstrumentationScope.toJSON(message.scope);
    }
    if (message.logRecords?.length) {
      obj.logRecords = message.logRecords.map((e) => LogRecord.toJSON(e));
    }
    if (message.schemaUrl !== "") {
      obj.schemaUrl = message.schemaUrl;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ScopeLogs>, I>>(base?: I): ScopeLogs {
    return ScopeLogs.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ScopeLogs>, I>>(object: I): ScopeLogs {
    const message = createBaseScopeLogs();
    message.scope = (object.scope !== undefined && object.scope !== null)
      ? InstrumentationScope.fromPartial(object.scope)
      : undefined;
    message.logRecords = object.logRecords?.map((e) => LogRecord.fromPartial(e)) || [];
    message.schemaUrl = object.schemaUrl ?? "";
    return message;
  },
};

function createBaseLogRecord(): LogRecord {
  return {
    timeUnixNano: BigInt("0"),
    observedTimeUnixNano: BigInt("0"),
    severityNumber: 0,
    severityText: "",
    body: undefined,
    attributes: [],
    droppedAttributesCount: 0,
    flags: 0,
    traceId: Buffer.alloc(0),
    spanId: Buffer.alloc(0),
  };
}

export const LogRecord = {
  encode(message: LogRecord, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.timeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.timeUnixNano) !== message.timeUnixNano) {
        throw new globalThis.Error("value provided for field message.timeUnixNano of type fixed64 too large");
      }
      writer.uint32(9).fixed64(message.timeUnixNano.toString());
    }
    if (message.observedTimeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.observedTimeUnixNano) !== message.observedTimeUnixNano) {
        throw new globalThis.Error("value provided for field message.observedTimeUnixNano of type fixed64 too large");
      }
      writer.uint32(89).fixed64(message.observedTimeUnixNano.toString());
    }
    if (message.severityNumber !== 0) {
      writer.uint32(16).int32(message.severityNumber);
    }
    if (message.severityText !== "") {
      writer.uint32(26).string(message.severityText);
    }
    if (message.body !== undefined) {
      AnyValue.encode(message.body, writer.uint32(42).fork()).ldelim();
    }
    for (const v of message.attributes) {
      KeyValue.encode(v!, writer.uint32(50).fork()).ldelim();
    }
    if (message.droppedAttributesCount !== 0) {
      writer.uint32(56).uint32(message.droppedAttributesCount);
    }
    if (message.flags !== 0) {
      writer.uint32(69).fixed32(message.flags);
    }
    if (message.traceId.length !== 0) {
      writer.uint32(74).bytes(message.traceId);
    }
    if (message.spanId.length !== 0) {
      writer.uint32(82).bytes(message.spanId);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): LogRecord {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseLogRecord();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 9) {
            break;
          }

          message.timeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 11:
          if (tag !== 89) {
            break;
          }

          message.observedTimeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 2:
          if (tag !== 16) {
            break;
          }

          message.severityNumber = reader.int32() as any;
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.severityText = reader.string();
          continue;
        case 5:
          if (tag !== 42) {
            break;
          }

          message.body = AnyValue.decode(reader, reader.uint32());
          continue;
        case 6:
          if (tag !== 50) {
            break;
          }

          message.attributes.push(KeyValue.decode(reader, reader.uint32()));
          continue;
        case 7:
          if (tag !== 56) {
            break;
          }

          message.droppedAttributesCount = reader.uint32();
          continue;
        case 8:
          if (tag !== 69) {
            break;
          }

          message.flags = reader.fixed32();
          continue;
        case 9:
          if (tag !== 74) {
            break;
          }

          message.traceId = reader.bytes() as Buffer;
          continue;
        case 10:
          if (tag !== 82) {
            break;
          }

          message.spanId = reader.bytes() as Buffer;
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): LogRecord {
    return {
      timeUnixNano: isSet(object.timeUnixNano) ? BigInt(object.timeUnixNano) : BigInt("0"),
      observedTimeUnixNano: isSet(object.observedTimeUnixNano) ? BigInt(object.observedTimeUnixNano) : BigInt("0"),
      severityNumber: isSet(object.severityNumber) ? severityNumberFromJSON(object.severityNumber) : 0,
      severityText: isSet(object.severityText) ? globalThis.String(object.severityText) : "",
      body: isSet(object.body) ? AnyValue.fromJSON(object.body) : undefined,
      attributes: globalThis.Array.isArray(object?.attributes)
        ? object.attributes.map((e: any) => KeyValue.fromJSON(e))
        : [],
      droppedAttributesCount: isSet(object.droppedAttributesCount)
        ? globalThis.Number(object.droppedAttributesCount)
        : 0,
      flags: isSet(object.flags) ? globalThis.Number(object.flags) : 0,
      traceId: isSet(object.traceId) ? Buffer.from(bytesFromBase64(object.traceId)) : Buffer.alloc(0),
      spanId: isSet(object.spanId) ? Buffer.from(bytesFromBase64(object.spanId)) : Buffer.alloc(0),
    };
  },

  toJSON(message: LogRecord): unknown {
    const obj: any = {};
    if (message.timeUnixNano !== BigInt("0")) {
      obj.timeUnixNano = message.timeUnixNano.toString();
    }
    if (message.observedTimeUnixNano !== BigInt("0")) {
      obj.observedTimeUnixNano = message.observedTimeUnixNano.toString();
    }
    if (message.severityNumber !== 0) {
      obj.severityNumber = severityNumberToJSON(message.severityNumber);
    }
    if (message.severityText !== "") {
      obj.severityText = message.severityText;
    }
    if (message.body !== undefined) {
      obj.body = AnyValue.toJSON(message.body);
    }
    if (message.attributes?.length) {
      obj.attributes = message.attributes.map((e) => KeyValue.toJSON(e));
    }
    if (message.droppedAttributesCount !== 0) {
      obj.droppedAttributesCount = Math.round(message.droppedAttributesCount);
    }
    if (message.flags !== 0) {
      obj.flags = Math.round(message.flags);
    }
    if (message.traceId.length !== 0) {
      obj.traceId = base64FromBytes(message.traceId);
    }
    if (message.spanId.length !== 0) {
      obj.spanId = base64FromBytes(message.spanId);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<LogRecord>, I>>(base?: I): LogRecord {
    return LogRecord.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<LogRecord>, I>>(object: I): LogRecord {
    const message = createBaseLogRecord();
    message.timeUnixNano = object.timeUnixNano ?? BigInt("0");
    message.observedTimeUnixNano = object.observedTimeUnixNano ?? BigInt("0");
    message.severityNumber = object.severityNumber ?? 0;
    message.severityText = object.severityText ?? "";
    message.body = (object.body !== undefined && object.body !== null) ? AnyValue.fromPartial(object.body) : undefined;
    message.attributes = object.attributes?.map((e) => KeyValue.fromPartial(e)) || [];
    message.droppedAttributesCount = object.droppedAttributesCount ?? 0;
    message.flags = object.flags ?? 0;
    message.traceId = object.traceId ?? Buffer.alloc(0);
    message.spanId = object.spanId ?? Buffer.alloc(0);
    return message;
  },
};

function bytesFromBase64(b64: string): Uint8Array {
  if (globalThis.Buffer) {
    return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
  } else {
    const bin = globalThis.atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; ++i) {
      arr[i] = bin.charCodeAt(i);
    }
    return arr;
  }
}

function base64FromBytes(arr: Uint8Array): string {
  if (globalThis.Buffer) {
    return globalThis.Buffer.from(arr).toString("base64");
  } else {
    const bin: string[] = [];
    arr.forEach((byte) => {
      bin.push(globalThis.String.fromCharCode(byte));
    });
    return globalThis.btoa(bin.join(""));
  }
}

type Builtin = Date | Function | Uint8Array | string | number | boolean | bigint | undefined;

export type DeepPartial<T> = T extends Builtin ? T
  : T extends globalThis.Array<infer U> ? globalThis.Array<DeepPartial<U>>
  : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>>
  : T extends {} ? { [K in keyof T]?: DeepPartial<T[K]> }
  : Partial<T>;

type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin ? P
  : P & { [K in keyof P]: Exact<P[K], I[K]> } & { [K in Exclude<keyof I, KeysOfUnion<P>>]: never };

function longToBigint(long: Long) {
  return BigInt(long.toString());
}

if (_m0.util.Long !== Long) {
  _m0.util.Long = Long as any;
  _m0.configure();
}

function isSet(value: any): boolean {
  return value !== null && value !== undefined;
}
