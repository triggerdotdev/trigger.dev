/* eslint-disable */
import Long from "long";
import _m0 from "protobufjs/minimal";
import { ResourceLogs } from "../../../logs/v1/logs";

export const protobufPackage = "opentelemetry.proto.collector.logs.v1";

export interface ExportLogsServiceRequest {
  /**
   * An array of ResourceLogs.
   * For data coming from a single resource this array will typically contain one
   * element. Intermediary nodes (such as OpenTelemetry Collector) that receive
   * data from multiple origins typically batch the data before forwarding further and
   * in that case this array will contain multiple elements.
   */
  resourceLogs: ResourceLogs[];
}

export interface ExportLogsServiceResponse {
  /**
   * The details of a partially successful export request.
   *
   * If the request is only partially accepted
   * (i.e. when the server accepts only parts of the data and rejects the rest)
   * the server MUST initialize the `partial_success` field and MUST
   * set the `rejected_<signal>` with the number of items it rejected.
   *
   * Servers MAY also make use of the `partial_success` field to convey
   * warnings/suggestions to senders even when the request was fully accepted.
   * In such cases, the `rejected_<signal>` MUST have a value of `0` and
   * the `error_message` MUST be non-empty.
   *
   * A `partial_success` message with an empty value (rejected_<signal> = 0 and
   * `error_message` = "") is equivalent to it not being set/present. Senders
   * SHOULD interpret it the same way as in the full success case.
   */
  partialSuccess: ExportLogsPartialSuccess | undefined;
}

export interface ExportLogsPartialSuccess {
  /**
   * The number of rejected log records.
   *
   * A `rejected_<signal>` field holding a `0` value indicates that the
   * request was fully accepted.
   */
  rejectedLogRecords: bigint;
  /**
   * A developer-facing human-readable message in English. It should be used
   * either to explain why the server rejected parts of the data during a partial
   * success or to convey warnings/suggestions during a full success. The message
   * should offer guidance on how users can address such issues.
   *
   * error_message is an optional field. An error_message with an empty value
   * is equivalent to it not being set.
   */
  errorMessage: string;
}

function createBaseExportLogsServiceRequest(): ExportLogsServiceRequest {
  return { resourceLogs: [] };
}

export const ExportLogsServiceRequest = {
  encode(message: ExportLogsServiceRequest, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.resourceLogs) {
      ResourceLogs.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExportLogsServiceRequest {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExportLogsServiceRequest();
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

  fromJSON(object: any): ExportLogsServiceRequest {
    return {
      resourceLogs: globalThis.Array.isArray(object?.resourceLogs)
        ? object.resourceLogs.map((e: any) => ResourceLogs.fromJSON(e))
        : [],
    };
  },

  toJSON(message: ExportLogsServiceRequest): unknown {
    const obj: any = {};
    if (message.resourceLogs?.length) {
      obj.resourceLogs = message.resourceLogs.map((e) => ResourceLogs.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExportLogsServiceRequest>, I>>(base?: I): ExportLogsServiceRequest {
    return ExportLogsServiceRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExportLogsServiceRequest>, I>>(object: I): ExportLogsServiceRequest {
    const message = createBaseExportLogsServiceRequest();
    message.resourceLogs = object.resourceLogs?.map((e) => ResourceLogs.fromPartial(e)) || [];
    return message;
  },
};

function createBaseExportLogsServiceResponse(): ExportLogsServiceResponse {
  return { partialSuccess: undefined };
}

export const ExportLogsServiceResponse = {
  encode(message: ExportLogsServiceResponse, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.partialSuccess !== undefined) {
      ExportLogsPartialSuccess.encode(message.partialSuccess, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExportLogsServiceResponse {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExportLogsServiceResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.partialSuccess = ExportLogsPartialSuccess.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ExportLogsServiceResponse {
    return {
      partialSuccess: isSet(object.partialSuccess)
        ? ExportLogsPartialSuccess.fromJSON(object.partialSuccess)
        : undefined,
    };
  },

  toJSON(message: ExportLogsServiceResponse): unknown {
    const obj: any = {};
    if (message.partialSuccess !== undefined) {
      obj.partialSuccess = ExportLogsPartialSuccess.toJSON(message.partialSuccess);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExportLogsServiceResponse>, I>>(base?: I): ExportLogsServiceResponse {
    return ExportLogsServiceResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExportLogsServiceResponse>, I>>(object: I): ExportLogsServiceResponse {
    const message = createBaseExportLogsServiceResponse();
    message.partialSuccess = (object.partialSuccess !== undefined && object.partialSuccess !== null)
      ? ExportLogsPartialSuccess.fromPartial(object.partialSuccess)
      : undefined;
    return message;
  },
};

function createBaseExportLogsPartialSuccess(): ExportLogsPartialSuccess {
  return { rejectedLogRecords: BigInt("0"), errorMessage: "" };
}

export const ExportLogsPartialSuccess = {
  encode(message: ExportLogsPartialSuccess, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.rejectedLogRecords !== BigInt("0")) {
      if (BigInt.asIntN(64, message.rejectedLogRecords) !== message.rejectedLogRecords) {
        throw new globalThis.Error("value provided for field message.rejectedLogRecords of type int64 too large");
      }
      writer.uint32(8).int64(message.rejectedLogRecords.toString());
    }
    if (message.errorMessage !== "") {
      writer.uint32(18).string(message.errorMessage);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExportLogsPartialSuccess {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExportLogsPartialSuccess();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.rejectedLogRecords = longToBigint(reader.int64() as Long);
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.errorMessage = reader.string();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ExportLogsPartialSuccess {
    return {
      rejectedLogRecords: isSet(object.rejectedLogRecords) ? BigInt(object.rejectedLogRecords) : BigInt("0"),
      errorMessage: isSet(object.errorMessage) ? globalThis.String(object.errorMessage) : "",
    };
  },

  toJSON(message: ExportLogsPartialSuccess): unknown {
    const obj: any = {};
    if (message.rejectedLogRecords !== BigInt("0")) {
      obj.rejectedLogRecords = message.rejectedLogRecords.toString();
    }
    if (message.errorMessage !== "") {
      obj.errorMessage = message.errorMessage;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExportLogsPartialSuccess>, I>>(base?: I): ExportLogsPartialSuccess {
    return ExportLogsPartialSuccess.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExportLogsPartialSuccess>, I>>(object: I): ExportLogsPartialSuccess {
    const message = createBaseExportLogsPartialSuccess();
    message.rejectedLogRecords = object.rejectedLogRecords ?? BigInt("0");
    message.errorMessage = object.errorMessage ?? "";
    return message;
  },
};

/**
 * Service that can be used to push logs between one Application instrumented with
 * OpenTelemetry and an collector, or between an collector and a central collector (in this
 * case logs are sent/received to/from multiple Applications).
 */
export interface LogsService {
  /**
   * For performance reasons, it is recommended to keep this RPC
   * alive for the entire life of the application.
   */
  export(request: ExportLogsServiceRequest): Promise<ExportLogsServiceResponse>;
}

export const LogsServiceServiceName = "opentelemetry.proto.collector.logs.v1.LogsService";
export class LogsServiceClientImpl implements LogsService {
  private readonly rpc: Rpc;
  private readonly service: string;
  constructor(rpc: Rpc, opts?: { service?: string }) {
    this.service = opts?.service || LogsServiceServiceName;
    this.rpc = rpc;
    this.export = this.export.bind(this);
  }
  export(request: ExportLogsServiceRequest): Promise<ExportLogsServiceResponse> {
    const data = ExportLogsServiceRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "Export", data);
    return promise.then((data) => ExportLogsServiceResponse.decode(_m0.Reader.create(data)));
  }
}

interface Rpc {
  request(service: string, method: string, data: Uint8Array): Promise<Uint8Array>;
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
