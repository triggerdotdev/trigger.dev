/* eslint-disable */
import Long from "long";
import _m0 from "protobufjs/minimal";
import { ResourceSpans } from "../../../trace/v1/trace";

export const protobufPackage = "opentelemetry.proto.collector.trace.v1";

export interface ExportTraceServiceRequest {
  /**
   * An array of ResourceSpans.
   * For data coming from a single resource this array will typically contain one
   * element. Intermediary nodes (such as OpenTelemetry Collector) that receive
   * data from multiple origins typically batch the data before forwarding further and
   * in that case this array will contain multiple elements.
   */
  resourceSpans: ResourceSpans[];
}

export interface ExportTraceServiceResponse {
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
  partialSuccess: ExportTracePartialSuccess | undefined;
}

export interface ExportTracePartialSuccess {
  /**
   * The number of rejected spans.
   *
   * A `rejected_<signal>` field holding a `0` value indicates that the
   * request was fully accepted.
   */
  rejectedSpans: bigint;
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

function createBaseExportTraceServiceRequest(): ExportTraceServiceRequest {
  return { resourceSpans: [] };
}

export const ExportTraceServiceRequest = {
  encode(message: ExportTraceServiceRequest, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.resourceSpans) {
      ResourceSpans.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExportTraceServiceRequest {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExportTraceServiceRequest();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.resourceSpans.push(ResourceSpans.decode(reader, reader.uint32()));
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ExportTraceServiceRequest {
    return {
      resourceSpans: globalThis.Array.isArray(object?.resourceSpans)
        ? object.resourceSpans.map((e: any) => ResourceSpans.fromJSON(e))
        : [],
    };
  },

  toJSON(message: ExportTraceServiceRequest): unknown {
    const obj: any = {};
    if (message.resourceSpans?.length) {
      obj.resourceSpans = message.resourceSpans.map((e) => ResourceSpans.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExportTraceServiceRequest>, I>>(base?: I): ExportTraceServiceRequest {
    return ExportTraceServiceRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExportTraceServiceRequest>, I>>(object: I): ExportTraceServiceRequest {
    const message = createBaseExportTraceServiceRequest();
    message.resourceSpans = object.resourceSpans?.map((e) => ResourceSpans.fromPartial(e)) || [];
    return message;
  },
};

function createBaseExportTraceServiceResponse(): ExportTraceServiceResponse {
  return { partialSuccess: undefined };
}

export const ExportTraceServiceResponse = {
  encode(message: ExportTraceServiceResponse, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.partialSuccess !== undefined) {
      ExportTracePartialSuccess.encode(message.partialSuccess, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExportTraceServiceResponse {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExportTraceServiceResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.partialSuccess = ExportTracePartialSuccess.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ExportTraceServiceResponse {
    return {
      partialSuccess: isSet(object.partialSuccess)
        ? ExportTracePartialSuccess.fromJSON(object.partialSuccess)
        : undefined,
    };
  },

  toJSON(message: ExportTraceServiceResponse): unknown {
    const obj: any = {};
    if (message.partialSuccess !== undefined) {
      obj.partialSuccess = ExportTracePartialSuccess.toJSON(message.partialSuccess);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExportTraceServiceResponse>, I>>(base?: I): ExportTraceServiceResponse {
    return ExportTraceServiceResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExportTraceServiceResponse>, I>>(object: I): ExportTraceServiceResponse {
    const message = createBaseExportTraceServiceResponse();
    message.partialSuccess = (object.partialSuccess !== undefined && object.partialSuccess !== null)
      ? ExportTracePartialSuccess.fromPartial(object.partialSuccess)
      : undefined;
    return message;
  },
};

function createBaseExportTracePartialSuccess(): ExportTracePartialSuccess {
  return { rejectedSpans: BigInt("0"), errorMessage: "" };
}

export const ExportTracePartialSuccess = {
  encode(message: ExportTracePartialSuccess, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.rejectedSpans !== BigInt("0")) {
      if (BigInt.asIntN(64, message.rejectedSpans) !== message.rejectedSpans) {
        throw new globalThis.Error("value provided for field message.rejectedSpans of type int64 too large");
      }
      writer.uint32(8).int64(message.rejectedSpans.toString());
    }
    if (message.errorMessage !== "") {
      writer.uint32(18).string(message.errorMessage);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExportTracePartialSuccess {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExportTracePartialSuccess();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.rejectedSpans = longToBigint(reader.int64() as Long);
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

  fromJSON(object: any): ExportTracePartialSuccess {
    return {
      rejectedSpans: isSet(object.rejectedSpans) ? BigInt(object.rejectedSpans) : BigInt("0"),
      errorMessage: isSet(object.errorMessage) ? globalThis.String(object.errorMessage) : "",
    };
  },

  toJSON(message: ExportTracePartialSuccess): unknown {
    const obj: any = {};
    if (message.rejectedSpans !== BigInt("0")) {
      obj.rejectedSpans = message.rejectedSpans.toString();
    }
    if (message.errorMessage !== "") {
      obj.errorMessage = message.errorMessage;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExportTracePartialSuccess>, I>>(base?: I): ExportTracePartialSuccess {
    return ExportTracePartialSuccess.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExportTracePartialSuccess>, I>>(object: I): ExportTracePartialSuccess {
    const message = createBaseExportTracePartialSuccess();
    message.rejectedSpans = object.rejectedSpans ?? BigInt("0");
    message.errorMessage = object.errorMessage ?? "";
    return message;
  },
};

/**
 * Service that can be used to push spans between one Application instrumented with
 * OpenTelemetry and a collector, or between a collector and a central collector (in this
 * case spans are sent/received to/from multiple Applications).
 */
export interface TraceService {
  /**
   * For performance reasons, it is recommended to keep this RPC
   * alive for the entire life of the application.
   */
  export(request: ExportTraceServiceRequest): Promise<ExportTraceServiceResponse>;
}

export const TraceServiceServiceName = "opentelemetry.proto.collector.trace.v1.TraceService";
export class TraceServiceClientImpl implements TraceService {
  private readonly rpc: Rpc;
  private readonly service: string;
  constructor(rpc: Rpc, opts?: { service?: string }) {
    this.service = opts?.service || TraceServiceServiceName;
    this.rpc = rpc;
    this.export = this.export.bind(this);
  }
  export(request: ExportTraceServiceRequest): Promise<ExportTraceServiceResponse> {
    const data = ExportTraceServiceRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "Export", data);
    return promise.then((data) => ExportTraceServiceResponse.decode(_m0.Reader.create(data)));
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
