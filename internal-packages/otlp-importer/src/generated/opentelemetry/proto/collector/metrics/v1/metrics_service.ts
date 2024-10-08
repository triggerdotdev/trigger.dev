/* eslint-disable */
import Long from "long";
import _m0 from "protobufjs/minimal";
import { ResourceMetrics } from "../../../metrics/v1/metrics";

export const protobufPackage = "opentelemetry.proto.collector.metrics.v1";

export interface ExportMetricsServiceRequest {
  /**
   * An array of ResourceMetrics.
   * For data coming from a single resource this array will typically contain one
   * element. Intermediary nodes (such as OpenTelemetry Collector) that receive
   * data from multiple origins typically batch the data before forwarding further and
   * in that case this array will contain multiple elements.
   */
  resourceMetrics: ResourceMetrics[];
}

export interface ExportMetricsServiceResponse {
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
  partialSuccess: ExportMetricsPartialSuccess | undefined;
}

export interface ExportMetricsPartialSuccess {
  /**
   * The number of rejected data points.
   *
   * A `rejected_<signal>` field holding a `0` value indicates that the
   * request was fully accepted.
   */
  rejectedDataPoints: bigint;
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

function createBaseExportMetricsServiceRequest(): ExportMetricsServiceRequest {
  return { resourceMetrics: [] };
}

export const ExportMetricsServiceRequest = {
  encode(message: ExportMetricsServiceRequest, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.resourceMetrics) {
      ResourceMetrics.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExportMetricsServiceRequest {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExportMetricsServiceRequest();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.resourceMetrics.push(ResourceMetrics.decode(reader, reader.uint32()));
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ExportMetricsServiceRequest {
    return {
      resourceMetrics: globalThis.Array.isArray(object?.resourceMetrics)
        ? object.resourceMetrics.map((e: any) => ResourceMetrics.fromJSON(e))
        : [],
    };
  },

  toJSON(message: ExportMetricsServiceRequest): unknown {
    const obj: any = {};
    if (message.resourceMetrics?.length) {
      obj.resourceMetrics = message.resourceMetrics.map((e) => ResourceMetrics.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExportMetricsServiceRequest>, I>>(base?: I): ExportMetricsServiceRequest {
    return ExportMetricsServiceRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExportMetricsServiceRequest>, I>>(object: I): ExportMetricsServiceRequest {
    const message = createBaseExportMetricsServiceRequest();
    message.resourceMetrics = object.resourceMetrics?.map((e) => ResourceMetrics.fromPartial(e)) || [];
    return message;
  },
};

function createBaseExportMetricsServiceResponse(): ExportMetricsServiceResponse {
  return { partialSuccess: undefined };
}

export const ExportMetricsServiceResponse = {
  encode(message: ExportMetricsServiceResponse, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.partialSuccess !== undefined) {
      ExportMetricsPartialSuccess.encode(message.partialSuccess, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExportMetricsServiceResponse {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExportMetricsServiceResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.partialSuccess = ExportMetricsPartialSuccess.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ExportMetricsServiceResponse {
    return {
      partialSuccess: isSet(object.partialSuccess)
        ? ExportMetricsPartialSuccess.fromJSON(object.partialSuccess)
        : undefined,
    };
  },

  toJSON(message: ExportMetricsServiceResponse): unknown {
    const obj: any = {};
    if (message.partialSuccess !== undefined) {
      obj.partialSuccess = ExportMetricsPartialSuccess.toJSON(message.partialSuccess);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExportMetricsServiceResponse>, I>>(base?: I): ExportMetricsServiceResponse {
    return ExportMetricsServiceResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExportMetricsServiceResponse>, I>>(object: I): ExportMetricsServiceResponse {
    const message = createBaseExportMetricsServiceResponse();
    message.partialSuccess = (object.partialSuccess !== undefined && object.partialSuccess !== null)
      ? ExportMetricsPartialSuccess.fromPartial(object.partialSuccess)
      : undefined;
    return message;
  },
};

function createBaseExportMetricsPartialSuccess(): ExportMetricsPartialSuccess {
  return { rejectedDataPoints: BigInt("0"), errorMessage: "" };
}

export const ExportMetricsPartialSuccess = {
  encode(message: ExportMetricsPartialSuccess, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.rejectedDataPoints !== BigInt("0")) {
      if (BigInt.asIntN(64, message.rejectedDataPoints) !== message.rejectedDataPoints) {
        throw new globalThis.Error("value provided for field message.rejectedDataPoints of type int64 too large");
      }
      writer.uint32(8).int64(message.rejectedDataPoints.toString());
    }
    if (message.errorMessage !== "") {
      writer.uint32(18).string(message.errorMessage);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExportMetricsPartialSuccess {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExportMetricsPartialSuccess();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.rejectedDataPoints = longToBigint(reader.int64() as Long);
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

  fromJSON(object: any): ExportMetricsPartialSuccess {
    return {
      rejectedDataPoints: isSet(object.rejectedDataPoints) ? BigInt(object.rejectedDataPoints) : BigInt("0"),
      errorMessage: isSet(object.errorMessage) ? globalThis.String(object.errorMessage) : "",
    };
  },

  toJSON(message: ExportMetricsPartialSuccess): unknown {
    const obj: any = {};
    if (message.rejectedDataPoints !== BigInt("0")) {
      obj.rejectedDataPoints = message.rejectedDataPoints.toString();
    }
    if (message.errorMessage !== "") {
      obj.errorMessage = message.errorMessage;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExportMetricsPartialSuccess>, I>>(base?: I): ExportMetricsPartialSuccess {
    return ExportMetricsPartialSuccess.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExportMetricsPartialSuccess>, I>>(object: I): ExportMetricsPartialSuccess {
    const message = createBaseExportMetricsPartialSuccess();
    message.rejectedDataPoints = object.rejectedDataPoints ?? BigInt("0");
    message.errorMessage = object.errorMessage ?? "";
    return message;
  },
};

/**
 * Service that can be used to push metrics between one Application
 * instrumented with OpenTelemetry and a collector, or between a collector and a
 * central collector.
 */
export interface MetricsService {
  /**
   * For performance reasons, it is recommended to keep this RPC
   * alive for the entire life of the application.
   */
  export(request: ExportMetricsServiceRequest): Promise<ExportMetricsServiceResponse>;
}

export const MetricsServiceServiceName = "opentelemetry.proto.collector.metrics.v1.MetricsService";
export class MetricsServiceClientImpl implements MetricsService {
  private readonly rpc: Rpc;
  private readonly service: string;
  constructor(rpc: Rpc, opts?: { service?: string }) {
    this.service = opts?.service || MetricsServiceServiceName;
    this.rpc = rpc;
    this.export = this.export.bind(this);
  }
  export(request: ExportMetricsServiceRequest): Promise<ExportMetricsServiceResponse> {
    const data = ExportMetricsServiceRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "Export", data);
    return promise.then((data) => ExportMetricsServiceResponse.decode(_m0.Reader.create(data)));
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
