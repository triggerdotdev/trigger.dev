/* eslint-disable */
import Long from "long";
import _m0 from "protobufjs/minimal";
import { InstrumentationScope, KeyValue } from "../../common/v1/common";
import { Resource } from "../../resource/v1/resource";

export const protobufPackage = "opentelemetry.proto.metrics.v1";

/**
 * AggregationTemporality defines how a metric aggregator reports aggregated
 * values. It describes how those values relate to the time interval over
 * which they are aggregated.
 */
export enum AggregationTemporality {
  /** UNSPECIFIED - UNSPECIFIED is the default AggregationTemporality, it MUST not be used. */
  UNSPECIFIED = 0,
  /**
   * DELTA - DELTA is an AggregationTemporality for a metric aggregator which reports
   * changes since last report time. Successive metrics contain aggregation of
   * values from continuous and non-overlapping intervals.
   *
   * The values for a DELTA metric are based only on the time interval
   * associated with one measurement cycle. There is no dependency on
   * previous measurements like is the case for CUMULATIVE metrics.
   *
   * For example, consider a system measuring the number of requests that
   * it receives and reports the sum of these requests every second as a
   * DELTA metric:
   *
   *   1. The system starts receiving at time=t_0.
   *   2. A request is received, the system measures 1 request.
   *   3. A request is received, the system measures 1 request.
   *   4. A request is received, the system measures 1 request.
   *   5. The 1 second collection cycle ends. A metric is exported for the
   *      number of requests received over the interval of time t_0 to
   *      t_0+1 with a value of 3.
   *   6. A request is received, the system measures 1 request.
   *   7. A request is received, the system measures 1 request.
   *   8. The 1 second collection cycle ends. A metric is exported for the
   *      number of requests received over the interval of time t_0+1 to
   *      t_0+2 with a value of 2.
   */
  DELTA = 1,
  /**
   * CUMULATIVE - CUMULATIVE is an AggregationTemporality for a metric aggregator which
   * reports changes since a fixed start time. This means that current values
   * of a CUMULATIVE metric depend on all previous measurements since the
   * start time. Because of this, the sender is required to retain this state
   * in some form. If this state is lost or invalidated, the CUMULATIVE metric
   * values MUST be reset and a new fixed start time following the last
   * reported measurement time sent MUST be used.
   *
   * For example, consider a system measuring the number of requests that
   * it receives and reports the sum of these requests every second as a
   * CUMULATIVE metric:
   *
   *   1. The system starts receiving at time=t_0.
   *   2. A request is received, the system measures 1 request.
   *   3. A request is received, the system measures 1 request.
   *   4. A request is received, the system measures 1 request.
   *   5. The 1 second collection cycle ends. A metric is exported for the
   *      number of requests received over the interval of time t_0 to
   *      t_0+1 with a value of 3.
   *   6. A request is received, the system measures 1 request.
   *   7. A request is received, the system measures 1 request.
   *   8. The 1 second collection cycle ends. A metric is exported for the
   *      number of requests received over the interval of time t_0 to
   *      t_0+2 with a value of 5.
   *   9. The system experiences a fault and loses state.
   *   10. The system recovers and resumes receiving at time=t_1.
   *   11. A request is received, the system measures 1 request.
   *   12. The 1 second collection cycle ends. A metric is exported for the
   *      number of requests received over the interval of time t_1 to
   *      t_0+1 with a value of 1.
   *
   * Note: Even though, when reporting changes since last report time, using
   * CUMULATIVE is valid, it is not recommended. This may cause problems for
   * systems that do not use start_time to determine when the aggregation
   * value was reset (e.g. Prometheus).
   */
  CUMULATIVE = 2,
  UNRECOGNIZED = -1,
}

export function aggregationTemporalityFromJSON(object: any): AggregationTemporality {
  switch (object) {
    case 0:
    case "AGGREGATION_TEMPORALITY_UNSPECIFIED":
      return AggregationTemporality.UNSPECIFIED;
    case 1:
    case "AGGREGATION_TEMPORALITY_DELTA":
      return AggregationTemporality.DELTA;
    case 2:
    case "AGGREGATION_TEMPORALITY_CUMULATIVE":
      return AggregationTemporality.CUMULATIVE;
    case -1:
    case "UNRECOGNIZED":
    default:
      return AggregationTemporality.UNRECOGNIZED;
  }
}

export function aggregationTemporalityToJSON(object: AggregationTemporality): string {
  switch (object) {
    case AggregationTemporality.UNSPECIFIED:
      return "AGGREGATION_TEMPORALITY_UNSPECIFIED";
    case AggregationTemporality.DELTA:
      return "AGGREGATION_TEMPORALITY_DELTA";
    case AggregationTemporality.CUMULATIVE:
      return "AGGREGATION_TEMPORALITY_CUMULATIVE";
    case AggregationTemporality.UNRECOGNIZED:
    default:
      return "UNRECOGNIZED";
  }
}

/**
 * DataPointFlags is defined as a protobuf 'uint32' type and is to be used as a
 * bit-field representing 32 distinct boolean flags.  Each flag defined in this
 * enum is a bit-mask.  To test the presence of a single flag in the flags of
 * a data point, for example, use an expression like:
 *
 *   (point.flags & DATA_POINT_FLAGS_NO_RECORDED_VALUE_MASK) == DATA_POINT_FLAGS_NO_RECORDED_VALUE_MASK
 */
export enum DataPointFlags {
  /**
   * DO_NOT_USE - The zero value for the enum. Should not be used for comparisons.
   * Instead use bitwise "and" with the appropriate mask as shown above.
   */
  DO_NOT_USE = 0,
  /**
   * NO_RECORDED_VALUE_MASK - This DataPoint is valid but has no recorded value.  This value
   * SHOULD be used to reflect explicitly missing data in a series, as
   * for an equivalent to the Prometheus "staleness marker".
   */
  NO_RECORDED_VALUE_MASK = 1,
  UNRECOGNIZED = -1,
}

export function dataPointFlagsFromJSON(object: any): DataPointFlags {
  switch (object) {
    case 0:
    case "DATA_POINT_FLAGS_DO_NOT_USE":
      return DataPointFlags.DO_NOT_USE;
    case 1:
    case "DATA_POINT_FLAGS_NO_RECORDED_VALUE_MASK":
      return DataPointFlags.NO_RECORDED_VALUE_MASK;
    case -1:
    case "UNRECOGNIZED":
    default:
      return DataPointFlags.UNRECOGNIZED;
  }
}

export function dataPointFlagsToJSON(object: DataPointFlags): string {
  switch (object) {
    case DataPointFlags.DO_NOT_USE:
      return "DATA_POINT_FLAGS_DO_NOT_USE";
    case DataPointFlags.NO_RECORDED_VALUE_MASK:
      return "DATA_POINT_FLAGS_NO_RECORDED_VALUE_MASK";
    case DataPointFlags.UNRECOGNIZED:
    default:
      return "UNRECOGNIZED";
  }
}

/**
 * MetricsData represents the metrics data that can be stored in a persistent
 * storage, OR can be embedded by other protocols that transfer OTLP metrics
 * data but do not implement the OTLP protocol.
 *
 * The main difference between this message and collector protocol is that
 * in this message there will not be any "control" or "metadata" specific to
 * OTLP protocol.
 *
 * When new fields are added into this message, the OTLP request MUST be updated
 * as well.
 */
export interface MetricsData {
  /**
   * An array of ResourceMetrics.
   * For data coming from a single resource this array will typically contain
   * one element. Intermediary nodes that receive data from multiple origins
   * typically batch the data before forwarding further and in that case this
   * array will contain multiple elements.
   */
  resourceMetrics: ResourceMetrics[];
}

/** A collection of ScopeMetrics from a Resource. */
export interface ResourceMetrics {
  /**
   * The resource for the metrics in this message.
   * If this field is not set then no resource info is known.
   */
  resource:
    | Resource
    | undefined;
  /** A list of metrics that originate from a resource. */
  scopeMetrics: ScopeMetrics[];
  /**
   * The Schema URL, if known. This is the identifier of the Schema that the resource data
   * is recorded in. To learn more about Schema URL see
   * https://opentelemetry.io/docs/specs/otel/schemas/#schema-url
   * This schema_url applies to the data in the "resource" field. It does not apply
   * to the data in the "scope_metrics" field which have their own schema_url field.
   */
  schemaUrl: string;
}

/** A collection of Metrics produced by an Scope. */
export interface ScopeMetrics {
  /**
   * The instrumentation scope information for the metrics in this message.
   * Semantically when InstrumentationScope isn't set, it is equivalent with
   * an empty instrumentation scope name (unknown).
   */
  scope:
    | InstrumentationScope
    | undefined;
  /** A list of metrics that originate from an instrumentation library. */
  metrics: Metric[];
  /**
   * The Schema URL, if known. This is the identifier of the Schema that the metric data
   * is recorded in. To learn more about Schema URL see
   * https://opentelemetry.io/docs/specs/otel/schemas/#schema-url
   * This schema_url applies to all metrics in the "metrics" field.
   */
  schemaUrl: string;
}

/**
 * Defines a Metric which has one or more timeseries.  The following is a
 * brief summary of the Metric data model.  For more details, see:
 *
 *   https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/metrics/data-model.md
 *
 * The data model and relation between entities is shown in the
 * diagram below. Here, "DataPoint" is the term used to refer to any
 * one of the specific data point value types, and "points" is the term used
 * to refer to any one of the lists of points contained in the Metric.
 *
 * - Metric is composed of a metadata and data.
 * - Metadata part contains a name, description, unit.
 * - Data is one of the possible types (Sum, Gauge, Histogram, Summary).
 * - DataPoint contains timestamps, attributes, and one of the possible value type
 *   fields.
 *
 *     Metric
 *  +------------+
 *  |name        |
 *  |description |
 *  |unit        |     +------------------------------------+
 *  |data        |---> |Gauge, Sum, Histogram, Summary, ... |
 *  +------------+     +------------------------------------+
 *
 *    Data [One of Gauge, Sum, Histogram, Summary, ...]
 *  +-----------+
 *  |...        |  // Metadata about the Data.
 *  |points     |--+
 *  +-----------+  |
 *                 |      +---------------------------+
 *                 |      |DataPoint 1                |
 *                 v      |+------+------+   +------+ |
 *              +-----+   ||label |label |...|label | |
 *              |  1  |-->||value1|value2|...|valueN| |
 *              +-----+   |+------+------+   +------+ |
 *              |  .  |   |+-----+                    |
 *              |  .  |   ||value|                    |
 *              |  .  |   |+-----+                    |
 *              |  .  |   +---------------------------+
 *              |  .  |                   .
 *              |  .  |                   .
 *              |  .  |                   .
 *              |  .  |   +---------------------------+
 *              |  .  |   |DataPoint M                |
 *              +-----+   |+------+------+   +------+ |
 *              |  M  |-->||label |label |...|label | |
 *              +-----+   ||value1|value2|...|valueN| |
 *                        |+------+------+   +------+ |
 *                        |+-----+                    |
 *                        ||value|                    |
 *                        |+-----+                    |
 *                        +---------------------------+
 *
 * Each distinct type of DataPoint represents the output of a specific
 * aggregation function, the result of applying the DataPoint's
 * associated function of to one or more measurements.
 *
 * All DataPoint types have three common fields:
 * - Attributes includes key-value pairs associated with the data point
 * - TimeUnixNano is required, set to the end time of the aggregation
 * - StartTimeUnixNano is optional, but strongly encouraged for DataPoints
 *   having an AggregationTemporality field, as discussed below.
 *
 * Both TimeUnixNano and StartTimeUnixNano values are expressed as
 * UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January 1970.
 *
 * # TimeUnixNano
 *
 * This field is required, having consistent interpretation across
 * DataPoint types.  TimeUnixNano is the moment corresponding to when
 * the data point's aggregate value was captured.
 *
 * Data points with the 0 value for TimeUnixNano SHOULD be rejected
 * by consumers.
 *
 * # StartTimeUnixNano
 *
 * StartTimeUnixNano in general allows detecting when a sequence of
 * observations is unbroken.  This field indicates to consumers the
 * start time for points with cumulative and delta
 * AggregationTemporality, and it should be included whenever possible
 * to support correct rate calculation.  Although it may be omitted
 * when the start time is truly unknown, setting StartTimeUnixNano is
 * strongly encouraged.
 */
export interface Metric {
  /** name of the metric. */
  name: string;
  /** description of the metric, which can be used in documentation. */
  description: string;
  /**
   * unit in which the metric value is reported. Follows the format
   * described by http://unitsofmeasure.org/ucum.html.
   */
  unit: string;
  gauge?: Gauge | undefined;
  sum?: Sum | undefined;
  histogram?: Histogram | undefined;
  exponentialHistogram?: ExponentialHistogram | undefined;
  summary?:
    | Summary
    | undefined;
  /**
   * Additional metadata attributes that describe the metric. [Optional].
   * Attributes are non-identifying.
   * Consumers SHOULD NOT need to be aware of these attributes.
   * These attributes MAY be used to encode information allowing
   * for lossless roundtrip translation to / from another data model.
   * Attribute keys MUST be unique (it is not allowed to have more than one
   * attribute with the same key).
   */
  metadata: KeyValue[];
}

/**
 * Gauge represents the type of a scalar metric that always exports the
 * "current value" for every data point. It should be used for an "unknown"
 * aggregation.
 *
 * A Gauge does not support different aggregation temporalities. Given the
 * aggregation is unknown, points cannot be combined using the same
 * aggregation, regardless of aggregation temporalities. Therefore,
 * AggregationTemporality is not included. Consequently, this also means
 * "StartTimeUnixNano" is ignored for all data points.
 */
export interface Gauge {
  dataPoints: NumberDataPoint[];
}

/**
 * Sum represents the type of a scalar metric that is calculated as a sum of all
 * reported measurements over a time interval.
 */
export interface Sum {
  dataPoints: NumberDataPoint[];
  /**
   * aggregation_temporality describes if the aggregator reports delta changes
   * since last report time, or cumulative changes since a fixed start time.
   */
  aggregationTemporality: AggregationTemporality;
  /** If "true" means that the sum is monotonic. */
  isMonotonic: boolean;
}

/**
 * Histogram represents the type of a metric that is calculated by aggregating
 * as a Histogram of all reported measurements over a time interval.
 */
export interface Histogram {
  dataPoints: HistogramDataPoint[];
  /**
   * aggregation_temporality describes if the aggregator reports delta changes
   * since last report time, or cumulative changes since a fixed start time.
   */
  aggregationTemporality: AggregationTemporality;
}

/**
 * ExponentialHistogram represents the type of a metric that is calculated by aggregating
 * as a ExponentialHistogram of all reported double measurements over a time interval.
 */
export interface ExponentialHistogram {
  dataPoints: ExponentialHistogramDataPoint[];
  /**
   * aggregation_temporality describes if the aggregator reports delta changes
   * since last report time, or cumulative changes since a fixed start time.
   */
  aggregationTemporality: AggregationTemporality;
}

/**
 * Summary metric data are used to convey quantile summaries,
 * a Prometheus (see: https://prometheus.io/docs/concepts/metric_types/#summary)
 * and OpenMetrics (see: https://github.com/OpenObservability/OpenMetrics/blob/4dbf6075567ab43296eed941037c12951faafb92/protos/prometheus.proto#L45)
 * data type. These data points cannot always be merged in a meaningful way.
 * While they can be useful in some applications, histogram data points are
 * recommended for new applications.
 */
export interface Summary {
  dataPoints: SummaryDataPoint[];
}

/**
 * NumberDataPoint is a single data point in a timeseries that describes the
 * time-varying scalar value of a metric.
 */
export interface NumberDataPoint {
  /**
   * The set of key/value pairs that uniquely identify the timeseries from
   * where this point belongs. The list may be empty (may contain 0 elements).
   * Attribute keys MUST be unique (it is not allowed to have more than one
   * attribute with the same key).
   */
  attributes: KeyValue[];
  /**
   * StartTimeUnixNano is optional but strongly encouraged, see the
   * the detailed comments above Metric.
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January
   * 1970.
   */
  startTimeUnixNano: bigint;
  /**
   * TimeUnixNano is required, see the detailed comments above Metric.
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January
   * 1970.
   */
  timeUnixNano: bigint;
  asDouble?: number | undefined;
  asInt?:
    | bigint
    | undefined;
  /**
   * (Optional) List of exemplars collected from
   * measurements that were used to form the data point
   */
  exemplars: Exemplar[];
  /**
   * Flags that apply to this specific data point.  See DataPointFlags
   * for the available flags and their meaning.
   */
  flags: number;
}

/**
 * HistogramDataPoint is a single data point in a timeseries that describes the
 * time-varying values of a Histogram. A Histogram contains summary statistics
 * for a population of values, it may optionally contain the distribution of
 * those values across a set of buckets.
 *
 * If the histogram contains the distribution of values, then both
 * "explicit_bounds" and "bucket counts" fields must be defined.
 * If the histogram does not contain the distribution of values, then both
 * "explicit_bounds" and "bucket_counts" must be omitted and only "count" and
 * "sum" are known.
 */
export interface HistogramDataPoint {
  /**
   * The set of key/value pairs that uniquely identify the timeseries from
   * where this point belongs. The list may be empty (may contain 0 elements).
   * Attribute keys MUST be unique (it is not allowed to have more than one
   * attribute with the same key).
   */
  attributes: KeyValue[];
  /**
   * StartTimeUnixNano is optional but strongly encouraged, see the
   * the detailed comments above Metric.
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January
   * 1970.
   */
  startTimeUnixNano: bigint;
  /**
   * TimeUnixNano is required, see the detailed comments above Metric.
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January
   * 1970.
   */
  timeUnixNano: bigint;
  /**
   * count is the number of values in the population. Must be non-negative. This
   * value must be equal to the sum of the "count" fields in buckets if a
   * histogram is provided.
   */
  count: bigint;
  /**
   * sum of the values in the population. If count is zero then this field
   * must be zero.
   *
   * Note: Sum should only be filled out when measuring non-negative discrete
   * events, and is assumed to be monotonic over the values of these events.
   * Negative events *can* be recorded, but sum should not be filled out when
   * doing so.  This is specifically to enforce compatibility w/ OpenMetrics,
   * see: https://github.com/OpenObservability/OpenMetrics/blob/main/specification/OpenMetrics.md#histogram
   */
  sum?:
    | number
    | undefined;
  /**
   * bucket_counts is an optional field contains the count values of histogram
   * for each bucket.
   *
   * The sum of the bucket_counts must equal the value in the count field.
   *
   * The number of elements in bucket_counts array must be by one greater than
   * the number of elements in explicit_bounds array.
   */
  bucketCounts: bigint[];
  /**
   * explicit_bounds specifies buckets with explicitly defined bounds for values.
   *
   * The boundaries for bucket at index i are:
   *
   * (-infinity, explicit_bounds[i]] for i == 0
   * (explicit_bounds[i-1], explicit_bounds[i]] for 0 < i < size(explicit_bounds)
   * (explicit_bounds[i-1], +infinity) for i == size(explicit_bounds)
   *
   * The values in the explicit_bounds array must be strictly increasing.
   *
   * Histogram buckets are inclusive of their upper boundary, except the last
   * bucket where the boundary is at infinity. This format is intentionally
   * compatible with the OpenMetrics histogram definition.
   */
  explicitBounds: number[];
  /**
   * (Optional) List of exemplars collected from
   * measurements that were used to form the data point
   */
  exemplars: Exemplar[];
  /**
   * Flags that apply to this specific data point.  See DataPointFlags
   * for the available flags and their meaning.
   */
  flags: number;
  /** min is the minimum value over (start_time, end_time]. */
  min?:
    | number
    | undefined;
  /** max is the maximum value over (start_time, end_time]. */
  max?: number | undefined;
}

/**
 * ExponentialHistogramDataPoint is a single data point in a timeseries that describes the
 * time-varying values of a ExponentialHistogram of double values. A ExponentialHistogram contains
 * summary statistics for a population of values, it may optionally contain the
 * distribution of those values across a set of buckets.
 */
export interface ExponentialHistogramDataPoint {
  /**
   * The set of key/value pairs that uniquely identify the timeseries from
   * where this point belongs. The list may be empty (may contain 0 elements).
   * Attribute keys MUST be unique (it is not allowed to have more than one
   * attribute with the same key).
   */
  attributes: KeyValue[];
  /**
   * StartTimeUnixNano is optional but strongly encouraged, see the
   * the detailed comments above Metric.
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January
   * 1970.
   */
  startTimeUnixNano: bigint;
  /**
   * TimeUnixNano is required, see the detailed comments above Metric.
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January
   * 1970.
   */
  timeUnixNano: bigint;
  /**
   * count is the number of values in the population. Must be
   * non-negative. This value must be equal to the sum of the "bucket_counts"
   * values in the positive and negative Buckets plus the "zero_count" field.
   */
  count: bigint;
  /**
   * sum of the values in the population. If count is zero then this field
   * must be zero.
   *
   * Note: Sum should only be filled out when measuring non-negative discrete
   * events, and is assumed to be monotonic over the values of these events.
   * Negative events *can* be recorded, but sum should not be filled out when
   * doing so.  This is specifically to enforce compatibility w/ OpenMetrics,
   * see: https://github.com/OpenObservability/OpenMetrics/blob/main/specification/OpenMetrics.md#histogram
   */
  sum?:
    | number
    | undefined;
  /**
   * scale describes the resolution of the histogram.  Boundaries are
   * located at powers of the base, where:
   *
   *   base = (2^(2^-scale))
   *
   * The histogram bucket identified by `index`, a signed integer,
   * contains values that are greater than (base^index) and
   * less than or equal to (base^(index+1)).
   *
   * The positive and negative ranges of the histogram are expressed
   * separately.  Negative values are mapped by their absolute value
   * into the negative range using the same scale as the positive range.
   *
   * scale is not restricted by the protocol, as the permissible
   * values depend on the range of the data.
   */
  scale: number;
  /**
   * zero_count is the count of values that are either exactly zero or
   * within the region considered zero by the instrumentation at the
   * tolerated degree of precision.  This bucket stores values that
   * cannot be expressed using the standard exponential formula as
   * well as values that have been rounded to zero.
   *
   * Implementations MAY consider the zero bucket to have probability
   * mass equal to (zero_count / count).
   */
  zeroCount: bigint;
  /** positive carries the positive range of exponential bucket counts. */
  positive:
    | ExponentialHistogramDataPoint_Buckets
    | undefined;
  /** negative carries the negative range of exponential bucket counts. */
  negative:
    | ExponentialHistogramDataPoint_Buckets
    | undefined;
  /**
   * Flags that apply to this specific data point.  See DataPointFlags
   * for the available flags and their meaning.
   */
  flags: number;
  /**
   * (Optional) List of exemplars collected from
   * measurements that were used to form the data point
   */
  exemplars: Exemplar[];
  /** min is the minimum value over (start_time, end_time]. */
  min?:
    | number
    | undefined;
  /** max is the maximum value over (start_time, end_time]. */
  max?:
    | number
    | undefined;
  /**
   * ZeroThreshold may be optionally set to convey the width of the zero
   * region. Where the zero region is defined as the closed interval
   * [-ZeroThreshold, ZeroThreshold].
   * When ZeroThreshold is 0, zero count bucket stores values that cannot be
   * expressed using the standard exponential formula as well as values that
   * have been rounded to zero.
   */
  zeroThreshold: number;
}

/**
 * Buckets are a set of bucket counts, encoded in a contiguous array
 * of counts.
 */
export interface ExponentialHistogramDataPoint_Buckets {
  /**
   * Offset is the bucket index of the first entry in the bucket_counts array.
   *
   * Note: This uses a varint encoding as a simple form of compression.
   */
  offset: number;
  /**
   * bucket_counts is an array of count values, where bucket_counts[i] carries
   * the count of the bucket at index (offset+i). bucket_counts[i] is the count
   * of values greater than base^(offset+i) and less than or equal to
   * base^(offset+i+1).
   *
   * Note: By contrast, the explicit HistogramDataPoint uses
   * fixed64.  This field is expected to have many buckets,
   * especially zeros, so uint64 has been selected to ensure
   * varint encoding.
   */
  bucketCounts: bigint[];
}

/**
 * SummaryDataPoint is a single data point in a timeseries that describes the
 * time-varying values of a Summary metric.
 */
export interface SummaryDataPoint {
  /**
   * The set of key/value pairs that uniquely identify the timeseries from
   * where this point belongs. The list may be empty (may contain 0 elements).
   * Attribute keys MUST be unique (it is not allowed to have more than one
   * attribute with the same key).
   */
  attributes: KeyValue[];
  /**
   * StartTimeUnixNano is optional but strongly encouraged, see the
   * the detailed comments above Metric.
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January
   * 1970.
   */
  startTimeUnixNano: bigint;
  /**
   * TimeUnixNano is required, see the detailed comments above Metric.
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January
   * 1970.
   */
  timeUnixNano: bigint;
  /** count is the number of values in the population. Must be non-negative. */
  count: bigint;
  /**
   * sum of the values in the population. If count is zero then this field
   * must be zero.
   *
   * Note: Sum should only be filled out when measuring non-negative discrete
   * events, and is assumed to be monotonic over the values of these events.
   * Negative events *can* be recorded, but sum should not be filled out when
   * doing so.  This is specifically to enforce compatibility w/ OpenMetrics,
   * see: https://github.com/OpenObservability/OpenMetrics/blob/main/specification/OpenMetrics.md#summary
   */
  sum: number;
  /**
   * (Optional) list of values at different quantiles of the distribution calculated
   * from the current snapshot. The quantiles must be strictly increasing.
   */
  quantileValues: SummaryDataPoint_ValueAtQuantile[];
  /**
   * Flags that apply to this specific data point.  See DataPointFlags
   * for the available flags and their meaning.
   */
  flags: number;
}

/**
 * Represents the value at a given quantile of a distribution.
 *
 * To record Min and Max values following conventions are used:
 * - The 1.0 quantile is equivalent to the maximum value observed.
 * - The 0.0 quantile is equivalent to the minimum value observed.
 *
 * See the following issue for more context:
 * https://github.com/open-telemetry/opentelemetry-proto/issues/125
 */
export interface SummaryDataPoint_ValueAtQuantile {
  /**
   * The quantile of a distribution. Must be in the interval
   * [0.0, 1.0].
   */
  quantile: number;
  /**
   * The value at the given quantile of a distribution.
   *
   * Quantile values must NOT be negative.
   */
  value: number;
}

/**
 * A representation of an exemplar, which is a sample input measurement.
 * Exemplars also hold information about the environment when the measurement
 * was recorded, for example the span and trace ID of the active span when the
 * exemplar was recorded.
 */
export interface Exemplar {
  /**
   * The set of key/value pairs that were filtered out by the aggregator, but
   * recorded alongside the original measurement. Only key/value pairs that were
   * filtered out by the aggregator should be included
   */
  filteredAttributes: KeyValue[];
  /**
   * time_unix_nano is the exact time when this exemplar was recorded
   *
   * Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC on 1 January
   * 1970.
   */
  timeUnixNano: bigint;
  asDouble?: number | undefined;
  asInt?:
    | bigint
    | undefined;
  /**
   * (Optional) Span ID of the exemplar trace.
   * span_id may be missing if the measurement is not recorded inside a trace
   * or if the trace is not sampled.
   */
  spanId: Buffer;
  /**
   * (Optional) Trace ID of the exemplar trace.
   * trace_id may be missing if the measurement is not recorded inside a trace
   * or if the trace is not sampled.
   */
  traceId: Buffer;
}

function createBaseMetricsData(): MetricsData {
  return { resourceMetrics: [] };
}

export const MetricsData = {
  encode(message: MetricsData, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.resourceMetrics) {
      ResourceMetrics.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): MetricsData {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMetricsData();
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

  fromJSON(object: any): MetricsData {
    return {
      resourceMetrics: globalThis.Array.isArray(object?.resourceMetrics)
        ? object.resourceMetrics.map((e: any) => ResourceMetrics.fromJSON(e))
        : [],
    };
  },

  toJSON(message: MetricsData): unknown {
    const obj: any = {};
    if (message.resourceMetrics?.length) {
      obj.resourceMetrics = message.resourceMetrics.map((e) => ResourceMetrics.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<MetricsData>, I>>(base?: I): MetricsData {
    return MetricsData.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MetricsData>, I>>(object: I): MetricsData {
    const message = createBaseMetricsData();
    message.resourceMetrics = object.resourceMetrics?.map((e) => ResourceMetrics.fromPartial(e)) || [];
    return message;
  },
};

function createBaseResourceMetrics(): ResourceMetrics {
  return { resource: undefined, scopeMetrics: [], schemaUrl: "" };
}

export const ResourceMetrics = {
  encode(message: ResourceMetrics, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.resource !== undefined) {
      Resource.encode(message.resource, writer.uint32(10).fork()).ldelim();
    }
    for (const v of message.scopeMetrics) {
      ScopeMetrics.encode(v!, writer.uint32(18).fork()).ldelim();
    }
    if (message.schemaUrl !== "") {
      writer.uint32(26).string(message.schemaUrl);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ResourceMetrics {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseResourceMetrics();
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

          message.scopeMetrics.push(ScopeMetrics.decode(reader, reader.uint32()));
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

  fromJSON(object: any): ResourceMetrics {
    return {
      resource: isSet(object.resource) ? Resource.fromJSON(object.resource) : undefined,
      scopeMetrics: globalThis.Array.isArray(object?.scopeMetrics)
        ? object.scopeMetrics.map((e: any) => ScopeMetrics.fromJSON(e))
        : [],
      schemaUrl: isSet(object.schemaUrl) ? globalThis.String(object.schemaUrl) : "",
    };
  },

  toJSON(message: ResourceMetrics): unknown {
    const obj: any = {};
    if (message.resource !== undefined) {
      obj.resource = Resource.toJSON(message.resource);
    }
    if (message.scopeMetrics?.length) {
      obj.scopeMetrics = message.scopeMetrics.map((e) => ScopeMetrics.toJSON(e));
    }
    if (message.schemaUrl !== "") {
      obj.schemaUrl = message.schemaUrl;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ResourceMetrics>, I>>(base?: I): ResourceMetrics {
    return ResourceMetrics.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ResourceMetrics>, I>>(object: I): ResourceMetrics {
    const message = createBaseResourceMetrics();
    message.resource = (object.resource !== undefined && object.resource !== null)
      ? Resource.fromPartial(object.resource)
      : undefined;
    message.scopeMetrics = object.scopeMetrics?.map((e) => ScopeMetrics.fromPartial(e)) || [];
    message.schemaUrl = object.schemaUrl ?? "";
    return message;
  },
};

function createBaseScopeMetrics(): ScopeMetrics {
  return { scope: undefined, metrics: [], schemaUrl: "" };
}

export const ScopeMetrics = {
  encode(message: ScopeMetrics, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.scope !== undefined) {
      InstrumentationScope.encode(message.scope, writer.uint32(10).fork()).ldelim();
    }
    for (const v of message.metrics) {
      Metric.encode(v!, writer.uint32(18).fork()).ldelim();
    }
    if (message.schemaUrl !== "") {
      writer.uint32(26).string(message.schemaUrl);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ScopeMetrics {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseScopeMetrics();
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

          message.metrics.push(Metric.decode(reader, reader.uint32()));
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

  fromJSON(object: any): ScopeMetrics {
    return {
      scope: isSet(object.scope) ? InstrumentationScope.fromJSON(object.scope) : undefined,
      metrics: globalThis.Array.isArray(object?.metrics) ? object.metrics.map((e: any) => Metric.fromJSON(e)) : [],
      schemaUrl: isSet(object.schemaUrl) ? globalThis.String(object.schemaUrl) : "",
    };
  },

  toJSON(message: ScopeMetrics): unknown {
    const obj: any = {};
    if (message.scope !== undefined) {
      obj.scope = InstrumentationScope.toJSON(message.scope);
    }
    if (message.metrics?.length) {
      obj.metrics = message.metrics.map((e) => Metric.toJSON(e));
    }
    if (message.schemaUrl !== "") {
      obj.schemaUrl = message.schemaUrl;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ScopeMetrics>, I>>(base?: I): ScopeMetrics {
    return ScopeMetrics.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ScopeMetrics>, I>>(object: I): ScopeMetrics {
    const message = createBaseScopeMetrics();
    message.scope = (object.scope !== undefined && object.scope !== null)
      ? InstrumentationScope.fromPartial(object.scope)
      : undefined;
    message.metrics = object.metrics?.map((e) => Metric.fromPartial(e)) || [];
    message.schemaUrl = object.schemaUrl ?? "";
    return message;
  },
};

function createBaseMetric(): Metric {
  return {
    name: "",
    description: "",
    unit: "",
    gauge: undefined,
    sum: undefined,
    histogram: undefined,
    exponentialHistogram: undefined,
    summary: undefined,
    metadata: [],
  };
}

export const Metric = {
  encode(message: Metric, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.name !== "") {
      writer.uint32(10).string(message.name);
    }
    if (message.description !== "") {
      writer.uint32(18).string(message.description);
    }
    if (message.unit !== "") {
      writer.uint32(26).string(message.unit);
    }
    if (message.gauge !== undefined) {
      Gauge.encode(message.gauge, writer.uint32(42).fork()).ldelim();
    }
    if (message.sum !== undefined) {
      Sum.encode(message.sum, writer.uint32(58).fork()).ldelim();
    }
    if (message.histogram !== undefined) {
      Histogram.encode(message.histogram, writer.uint32(74).fork()).ldelim();
    }
    if (message.exponentialHistogram !== undefined) {
      ExponentialHistogram.encode(message.exponentialHistogram, writer.uint32(82).fork()).ldelim();
    }
    if (message.summary !== undefined) {
      Summary.encode(message.summary, writer.uint32(90).fork()).ldelim();
    }
    for (const v of message.metadata) {
      KeyValue.encode(v!, writer.uint32(98).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Metric {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMetric();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.name = reader.string();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.description = reader.string();
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.unit = reader.string();
          continue;
        case 5:
          if (tag !== 42) {
            break;
          }

          message.gauge = Gauge.decode(reader, reader.uint32());
          continue;
        case 7:
          if (tag !== 58) {
            break;
          }

          message.sum = Sum.decode(reader, reader.uint32());
          continue;
        case 9:
          if (tag !== 74) {
            break;
          }

          message.histogram = Histogram.decode(reader, reader.uint32());
          continue;
        case 10:
          if (tag !== 82) {
            break;
          }

          message.exponentialHistogram = ExponentialHistogram.decode(reader, reader.uint32());
          continue;
        case 11:
          if (tag !== 90) {
            break;
          }

          message.summary = Summary.decode(reader, reader.uint32());
          continue;
        case 12:
          if (tag !== 98) {
            break;
          }

          message.metadata.push(KeyValue.decode(reader, reader.uint32()));
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Metric {
    return {
      name: isSet(object.name) ? globalThis.String(object.name) : "",
      description: isSet(object.description) ? globalThis.String(object.description) : "",
      unit: isSet(object.unit) ? globalThis.String(object.unit) : "",
      gauge: isSet(object.gauge) ? Gauge.fromJSON(object.gauge) : undefined,
      sum: isSet(object.sum) ? Sum.fromJSON(object.sum) : undefined,
      histogram: isSet(object.histogram) ? Histogram.fromJSON(object.histogram) : undefined,
      exponentialHistogram: isSet(object.exponentialHistogram)
        ? ExponentialHistogram.fromJSON(object.exponentialHistogram)
        : undefined,
      summary: isSet(object.summary) ? Summary.fromJSON(object.summary) : undefined,
      metadata: globalThis.Array.isArray(object?.metadata) ? object.metadata.map((e: any) => KeyValue.fromJSON(e)) : [],
    };
  },

  toJSON(message: Metric): unknown {
    const obj: any = {};
    if (message.name !== "") {
      obj.name = message.name;
    }
    if (message.description !== "") {
      obj.description = message.description;
    }
    if (message.unit !== "") {
      obj.unit = message.unit;
    }
    if (message.gauge !== undefined) {
      obj.gauge = Gauge.toJSON(message.gauge);
    }
    if (message.sum !== undefined) {
      obj.sum = Sum.toJSON(message.sum);
    }
    if (message.histogram !== undefined) {
      obj.histogram = Histogram.toJSON(message.histogram);
    }
    if (message.exponentialHistogram !== undefined) {
      obj.exponentialHistogram = ExponentialHistogram.toJSON(message.exponentialHistogram);
    }
    if (message.summary !== undefined) {
      obj.summary = Summary.toJSON(message.summary);
    }
    if (message.metadata?.length) {
      obj.metadata = message.metadata.map((e) => KeyValue.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Metric>, I>>(base?: I): Metric {
    return Metric.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Metric>, I>>(object: I): Metric {
    const message = createBaseMetric();
    message.name = object.name ?? "";
    message.description = object.description ?? "";
    message.unit = object.unit ?? "";
    message.gauge = (object.gauge !== undefined && object.gauge !== null) ? Gauge.fromPartial(object.gauge) : undefined;
    message.sum = (object.sum !== undefined && object.sum !== null) ? Sum.fromPartial(object.sum) : undefined;
    message.histogram = (object.histogram !== undefined && object.histogram !== null)
      ? Histogram.fromPartial(object.histogram)
      : undefined;
    message.exponentialHistogram = (object.exponentialHistogram !== undefined && object.exponentialHistogram !== null)
      ? ExponentialHistogram.fromPartial(object.exponentialHistogram)
      : undefined;
    message.summary = (object.summary !== undefined && object.summary !== null)
      ? Summary.fromPartial(object.summary)
      : undefined;
    message.metadata = object.metadata?.map((e) => KeyValue.fromPartial(e)) || [];
    return message;
  },
};

function createBaseGauge(): Gauge {
  return { dataPoints: [] };
}

export const Gauge = {
  encode(message: Gauge, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.dataPoints) {
      NumberDataPoint.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Gauge {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseGauge();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.dataPoints.push(NumberDataPoint.decode(reader, reader.uint32()));
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Gauge {
    return {
      dataPoints: globalThis.Array.isArray(object?.dataPoints)
        ? object.dataPoints.map((e: any) => NumberDataPoint.fromJSON(e))
        : [],
    };
  },

  toJSON(message: Gauge): unknown {
    const obj: any = {};
    if (message.dataPoints?.length) {
      obj.dataPoints = message.dataPoints.map((e) => NumberDataPoint.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Gauge>, I>>(base?: I): Gauge {
    return Gauge.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Gauge>, I>>(object: I): Gauge {
    const message = createBaseGauge();
    message.dataPoints = object.dataPoints?.map((e) => NumberDataPoint.fromPartial(e)) || [];
    return message;
  },
};

function createBaseSum(): Sum {
  return { dataPoints: [], aggregationTemporality: 0, isMonotonic: false };
}

export const Sum = {
  encode(message: Sum, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.dataPoints) {
      NumberDataPoint.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    if (message.aggregationTemporality !== 0) {
      writer.uint32(16).int32(message.aggregationTemporality);
    }
    if (message.isMonotonic === true) {
      writer.uint32(24).bool(message.isMonotonic);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Sum {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseSum();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.dataPoints.push(NumberDataPoint.decode(reader, reader.uint32()));
          continue;
        case 2:
          if (tag !== 16) {
            break;
          }

          message.aggregationTemporality = reader.int32() as any;
          continue;
        case 3:
          if (tag !== 24) {
            break;
          }

          message.isMonotonic = reader.bool();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Sum {
    return {
      dataPoints: globalThis.Array.isArray(object?.dataPoints)
        ? object.dataPoints.map((e: any) => NumberDataPoint.fromJSON(e))
        : [],
      aggregationTemporality: isSet(object.aggregationTemporality)
        ? aggregationTemporalityFromJSON(object.aggregationTemporality)
        : 0,
      isMonotonic: isSet(object.isMonotonic) ? globalThis.Boolean(object.isMonotonic) : false,
    };
  },

  toJSON(message: Sum): unknown {
    const obj: any = {};
    if (message.dataPoints?.length) {
      obj.dataPoints = message.dataPoints.map((e) => NumberDataPoint.toJSON(e));
    }
    if (message.aggregationTemporality !== 0) {
      obj.aggregationTemporality = aggregationTemporalityToJSON(message.aggregationTemporality);
    }
    if (message.isMonotonic === true) {
      obj.isMonotonic = message.isMonotonic;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Sum>, I>>(base?: I): Sum {
    return Sum.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Sum>, I>>(object: I): Sum {
    const message = createBaseSum();
    message.dataPoints = object.dataPoints?.map((e) => NumberDataPoint.fromPartial(e)) || [];
    message.aggregationTemporality = object.aggregationTemporality ?? 0;
    message.isMonotonic = object.isMonotonic ?? false;
    return message;
  },
};

function createBaseHistogram(): Histogram {
  return { dataPoints: [], aggregationTemporality: 0 };
}

export const Histogram = {
  encode(message: Histogram, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.dataPoints) {
      HistogramDataPoint.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    if (message.aggregationTemporality !== 0) {
      writer.uint32(16).int32(message.aggregationTemporality);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Histogram {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseHistogram();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.dataPoints.push(HistogramDataPoint.decode(reader, reader.uint32()));
          continue;
        case 2:
          if (tag !== 16) {
            break;
          }

          message.aggregationTemporality = reader.int32() as any;
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Histogram {
    return {
      dataPoints: globalThis.Array.isArray(object?.dataPoints)
        ? object.dataPoints.map((e: any) => HistogramDataPoint.fromJSON(e))
        : [],
      aggregationTemporality: isSet(object.aggregationTemporality)
        ? aggregationTemporalityFromJSON(object.aggregationTemporality)
        : 0,
    };
  },

  toJSON(message: Histogram): unknown {
    const obj: any = {};
    if (message.dataPoints?.length) {
      obj.dataPoints = message.dataPoints.map((e) => HistogramDataPoint.toJSON(e));
    }
    if (message.aggregationTemporality !== 0) {
      obj.aggregationTemporality = aggregationTemporalityToJSON(message.aggregationTemporality);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Histogram>, I>>(base?: I): Histogram {
    return Histogram.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Histogram>, I>>(object: I): Histogram {
    const message = createBaseHistogram();
    message.dataPoints = object.dataPoints?.map((e) => HistogramDataPoint.fromPartial(e)) || [];
    message.aggregationTemporality = object.aggregationTemporality ?? 0;
    return message;
  },
};

function createBaseExponentialHistogram(): ExponentialHistogram {
  return { dataPoints: [], aggregationTemporality: 0 };
}

export const ExponentialHistogram = {
  encode(message: ExponentialHistogram, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.dataPoints) {
      ExponentialHistogramDataPoint.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    if (message.aggregationTemporality !== 0) {
      writer.uint32(16).int32(message.aggregationTemporality);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExponentialHistogram {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExponentialHistogram();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.dataPoints.push(ExponentialHistogramDataPoint.decode(reader, reader.uint32()));
          continue;
        case 2:
          if (tag !== 16) {
            break;
          }

          message.aggregationTemporality = reader.int32() as any;
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ExponentialHistogram {
    return {
      dataPoints: globalThis.Array.isArray(object?.dataPoints)
        ? object.dataPoints.map((e: any) => ExponentialHistogramDataPoint.fromJSON(e))
        : [],
      aggregationTemporality: isSet(object.aggregationTemporality)
        ? aggregationTemporalityFromJSON(object.aggregationTemporality)
        : 0,
    };
  },

  toJSON(message: ExponentialHistogram): unknown {
    const obj: any = {};
    if (message.dataPoints?.length) {
      obj.dataPoints = message.dataPoints.map((e) => ExponentialHistogramDataPoint.toJSON(e));
    }
    if (message.aggregationTemporality !== 0) {
      obj.aggregationTemporality = aggregationTemporalityToJSON(message.aggregationTemporality);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExponentialHistogram>, I>>(base?: I): ExponentialHistogram {
    return ExponentialHistogram.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExponentialHistogram>, I>>(object: I): ExponentialHistogram {
    const message = createBaseExponentialHistogram();
    message.dataPoints = object.dataPoints?.map((e) => ExponentialHistogramDataPoint.fromPartial(e)) || [];
    message.aggregationTemporality = object.aggregationTemporality ?? 0;
    return message;
  },
};

function createBaseSummary(): Summary {
  return { dataPoints: [] };
}

export const Summary = {
  encode(message: Summary, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.dataPoints) {
      SummaryDataPoint.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Summary {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseSummary();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.dataPoints.push(SummaryDataPoint.decode(reader, reader.uint32()));
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Summary {
    return {
      dataPoints: globalThis.Array.isArray(object?.dataPoints)
        ? object.dataPoints.map((e: any) => SummaryDataPoint.fromJSON(e))
        : [],
    };
  },

  toJSON(message: Summary): unknown {
    const obj: any = {};
    if (message.dataPoints?.length) {
      obj.dataPoints = message.dataPoints.map((e) => SummaryDataPoint.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Summary>, I>>(base?: I): Summary {
    return Summary.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Summary>, I>>(object: I): Summary {
    const message = createBaseSummary();
    message.dataPoints = object.dataPoints?.map((e) => SummaryDataPoint.fromPartial(e)) || [];
    return message;
  },
};

function createBaseNumberDataPoint(): NumberDataPoint {
  return {
    attributes: [],
    startTimeUnixNano: BigInt("0"),
    timeUnixNano: BigInt("0"),
    asDouble: undefined,
    asInt: undefined,
    exemplars: [],
    flags: 0,
  };
}

export const NumberDataPoint = {
  encode(message: NumberDataPoint, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.attributes) {
      KeyValue.encode(v!, writer.uint32(58).fork()).ldelim();
    }
    if (message.startTimeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.startTimeUnixNano) !== message.startTimeUnixNano) {
        throw new globalThis.Error("value provided for field message.startTimeUnixNano of type fixed64 too large");
      }
      writer.uint32(17).fixed64(message.startTimeUnixNano.toString());
    }
    if (message.timeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.timeUnixNano) !== message.timeUnixNano) {
        throw new globalThis.Error("value provided for field message.timeUnixNano of type fixed64 too large");
      }
      writer.uint32(25).fixed64(message.timeUnixNano.toString());
    }
    if (message.asDouble !== undefined) {
      writer.uint32(33).double(message.asDouble);
    }
    if (message.asInt !== undefined) {
      if (BigInt.asIntN(64, message.asInt) !== message.asInt) {
        throw new globalThis.Error("value provided for field message.asInt of type sfixed64 too large");
      }
      writer.uint32(49).sfixed64(message.asInt.toString());
    }
    for (const v of message.exemplars) {
      Exemplar.encode(v!, writer.uint32(42).fork()).ldelim();
    }
    if (message.flags !== 0) {
      writer.uint32(64).uint32(message.flags);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): NumberDataPoint {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseNumberDataPoint();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 7:
          if (tag !== 58) {
            break;
          }

          message.attributes.push(KeyValue.decode(reader, reader.uint32()));
          continue;
        case 2:
          if (tag !== 17) {
            break;
          }

          message.startTimeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 3:
          if (tag !== 25) {
            break;
          }

          message.timeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 4:
          if (tag !== 33) {
            break;
          }

          message.asDouble = reader.double();
          continue;
        case 6:
          if (tag !== 49) {
            break;
          }

          message.asInt = longToBigint(reader.sfixed64() as Long);
          continue;
        case 5:
          if (tag !== 42) {
            break;
          }

          message.exemplars.push(Exemplar.decode(reader, reader.uint32()));
          continue;
        case 8:
          if (tag !== 64) {
            break;
          }

          message.flags = reader.uint32();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): NumberDataPoint {
    return {
      attributes: globalThis.Array.isArray(object?.attributes)
        ? object.attributes.map((e: any) => KeyValue.fromJSON(e))
        : [],
      startTimeUnixNano: isSet(object.startTimeUnixNano) ? BigInt(object.startTimeUnixNano) : BigInt("0"),
      timeUnixNano: isSet(object.timeUnixNano) ? BigInt(object.timeUnixNano) : BigInt("0"),
      asDouble: isSet(object.asDouble) ? globalThis.Number(object.asDouble) : undefined,
      asInt: isSet(object.asInt) ? BigInt(object.asInt) : undefined,
      exemplars: globalThis.Array.isArray(object?.exemplars)
        ? object.exemplars.map((e: any) => Exemplar.fromJSON(e))
        : [],
      flags: isSet(object.flags) ? globalThis.Number(object.flags) : 0,
    };
  },

  toJSON(message: NumberDataPoint): unknown {
    const obj: any = {};
    if (message.attributes?.length) {
      obj.attributes = message.attributes.map((e) => KeyValue.toJSON(e));
    }
    if (message.startTimeUnixNano !== BigInt("0")) {
      obj.startTimeUnixNano = message.startTimeUnixNano.toString();
    }
    if (message.timeUnixNano !== BigInt("0")) {
      obj.timeUnixNano = message.timeUnixNano.toString();
    }
    if (message.asDouble !== undefined) {
      obj.asDouble = message.asDouble;
    }
    if (message.asInt !== undefined) {
      obj.asInt = message.asInt.toString();
    }
    if (message.exemplars?.length) {
      obj.exemplars = message.exemplars.map((e) => Exemplar.toJSON(e));
    }
    if (message.flags !== 0) {
      obj.flags = Math.round(message.flags);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<NumberDataPoint>, I>>(base?: I): NumberDataPoint {
    return NumberDataPoint.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<NumberDataPoint>, I>>(object: I): NumberDataPoint {
    const message = createBaseNumberDataPoint();
    message.attributes = object.attributes?.map((e) => KeyValue.fromPartial(e)) || [];
    message.startTimeUnixNano = object.startTimeUnixNano ?? BigInt("0");
    message.timeUnixNano = object.timeUnixNano ?? BigInt("0");
    message.asDouble = object.asDouble ?? undefined;
    message.asInt = object.asInt ?? undefined;
    message.exemplars = object.exemplars?.map((e) => Exemplar.fromPartial(e)) || [];
    message.flags = object.flags ?? 0;
    return message;
  },
};

function createBaseHistogramDataPoint(): HistogramDataPoint {
  return {
    attributes: [],
    startTimeUnixNano: BigInt("0"),
    timeUnixNano: BigInt("0"),
    count: BigInt("0"),
    sum: undefined,
    bucketCounts: [],
    explicitBounds: [],
    exemplars: [],
    flags: 0,
    min: undefined,
    max: undefined,
  };
}

export const HistogramDataPoint = {
  encode(message: HistogramDataPoint, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.attributes) {
      KeyValue.encode(v!, writer.uint32(74).fork()).ldelim();
    }
    if (message.startTimeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.startTimeUnixNano) !== message.startTimeUnixNano) {
        throw new globalThis.Error("value provided for field message.startTimeUnixNano of type fixed64 too large");
      }
      writer.uint32(17).fixed64(message.startTimeUnixNano.toString());
    }
    if (message.timeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.timeUnixNano) !== message.timeUnixNano) {
        throw new globalThis.Error("value provided for field message.timeUnixNano of type fixed64 too large");
      }
      writer.uint32(25).fixed64(message.timeUnixNano.toString());
    }
    if (message.count !== BigInt("0")) {
      if (BigInt.asUintN(64, message.count) !== message.count) {
        throw new globalThis.Error("value provided for field message.count of type fixed64 too large");
      }
      writer.uint32(33).fixed64(message.count.toString());
    }
    if (message.sum !== undefined) {
      writer.uint32(41).double(message.sum);
    }
    writer.uint32(50).fork();
    for (const v of message.bucketCounts) {
      if (BigInt.asUintN(64, v) !== v) {
        throw new globalThis.Error("a value provided in array field bucketCounts of type fixed64 is too large");
      }
      writer.fixed64(v.toString());
    }
    writer.ldelim();
    writer.uint32(58).fork();
    for (const v of message.explicitBounds) {
      writer.double(v);
    }
    writer.ldelim();
    for (const v of message.exemplars) {
      Exemplar.encode(v!, writer.uint32(66).fork()).ldelim();
    }
    if (message.flags !== 0) {
      writer.uint32(80).uint32(message.flags);
    }
    if (message.min !== undefined) {
      writer.uint32(89).double(message.min);
    }
    if (message.max !== undefined) {
      writer.uint32(97).double(message.max);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): HistogramDataPoint {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseHistogramDataPoint();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 9:
          if (tag !== 74) {
            break;
          }

          message.attributes.push(KeyValue.decode(reader, reader.uint32()));
          continue;
        case 2:
          if (tag !== 17) {
            break;
          }

          message.startTimeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 3:
          if (tag !== 25) {
            break;
          }

          message.timeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 4:
          if (tag !== 33) {
            break;
          }

          message.count = longToBigint(reader.fixed64() as Long);
          continue;
        case 5:
          if (tag !== 41) {
            break;
          }

          message.sum = reader.double();
          continue;
        case 6:
          if (tag === 49) {
            message.bucketCounts.push(longToBigint(reader.fixed64() as Long));

            continue;
          }

          if (tag === 50) {
            const end2 = reader.uint32() + reader.pos;
            while (reader.pos < end2) {
              message.bucketCounts.push(longToBigint(reader.fixed64() as Long));
            }

            continue;
          }

          break;
        case 7:
          if (tag === 57) {
            message.explicitBounds.push(reader.double());

            continue;
          }

          if (tag === 58) {
            const end2 = reader.uint32() + reader.pos;
            while (reader.pos < end2) {
              message.explicitBounds.push(reader.double());
            }

            continue;
          }

          break;
        case 8:
          if (tag !== 66) {
            break;
          }

          message.exemplars.push(Exemplar.decode(reader, reader.uint32()));
          continue;
        case 10:
          if (tag !== 80) {
            break;
          }

          message.flags = reader.uint32();
          continue;
        case 11:
          if (tag !== 89) {
            break;
          }

          message.min = reader.double();
          continue;
        case 12:
          if (tag !== 97) {
            break;
          }

          message.max = reader.double();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): HistogramDataPoint {
    return {
      attributes: globalThis.Array.isArray(object?.attributes)
        ? object.attributes.map((e: any) => KeyValue.fromJSON(e))
        : [],
      startTimeUnixNano: isSet(object.startTimeUnixNano) ? BigInt(object.startTimeUnixNano) : BigInt("0"),
      timeUnixNano: isSet(object.timeUnixNano) ? BigInt(object.timeUnixNano) : BigInt("0"),
      count: isSet(object.count) ? BigInt(object.count) : BigInt("0"),
      sum: isSet(object.sum) ? globalThis.Number(object.sum) : undefined,
      bucketCounts: globalThis.Array.isArray(object?.bucketCounts)
        ? object.bucketCounts.map((e: any) => BigInt(e))
        : [],
      explicitBounds: globalThis.Array.isArray(object?.explicitBounds)
        ? object.explicitBounds.map((e: any) => globalThis.Number(e))
        : [],
      exemplars: globalThis.Array.isArray(object?.exemplars)
        ? object.exemplars.map((e: any) => Exemplar.fromJSON(e))
        : [],
      flags: isSet(object.flags) ? globalThis.Number(object.flags) : 0,
      min: isSet(object.min) ? globalThis.Number(object.min) : undefined,
      max: isSet(object.max) ? globalThis.Number(object.max) : undefined,
    };
  },

  toJSON(message: HistogramDataPoint): unknown {
    const obj: any = {};
    if (message.attributes?.length) {
      obj.attributes = message.attributes.map((e) => KeyValue.toJSON(e));
    }
    if (message.startTimeUnixNano !== BigInt("0")) {
      obj.startTimeUnixNano = message.startTimeUnixNano.toString();
    }
    if (message.timeUnixNano !== BigInt("0")) {
      obj.timeUnixNano = message.timeUnixNano.toString();
    }
    if (message.count !== BigInt("0")) {
      obj.count = message.count.toString();
    }
    if (message.sum !== undefined) {
      obj.sum = message.sum;
    }
    if (message.bucketCounts?.length) {
      obj.bucketCounts = message.bucketCounts.map((e) => e.toString());
    }
    if (message.explicitBounds?.length) {
      obj.explicitBounds = message.explicitBounds;
    }
    if (message.exemplars?.length) {
      obj.exemplars = message.exemplars.map((e) => Exemplar.toJSON(e));
    }
    if (message.flags !== 0) {
      obj.flags = Math.round(message.flags);
    }
    if (message.min !== undefined) {
      obj.min = message.min;
    }
    if (message.max !== undefined) {
      obj.max = message.max;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<HistogramDataPoint>, I>>(base?: I): HistogramDataPoint {
    return HistogramDataPoint.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<HistogramDataPoint>, I>>(object: I): HistogramDataPoint {
    const message = createBaseHistogramDataPoint();
    message.attributes = object.attributes?.map((e) => KeyValue.fromPartial(e)) || [];
    message.startTimeUnixNano = object.startTimeUnixNano ?? BigInt("0");
    message.timeUnixNano = object.timeUnixNano ?? BigInt("0");
    message.count = object.count ?? BigInt("0");
    message.sum = object.sum ?? undefined;
    message.bucketCounts = object.bucketCounts?.map((e) => e) || [];
    message.explicitBounds = object.explicitBounds?.map((e) => e) || [];
    message.exemplars = object.exemplars?.map((e) => Exemplar.fromPartial(e)) || [];
    message.flags = object.flags ?? 0;
    message.min = object.min ?? undefined;
    message.max = object.max ?? undefined;
    return message;
  },
};

function createBaseExponentialHistogramDataPoint(): ExponentialHistogramDataPoint {
  return {
    attributes: [],
    startTimeUnixNano: BigInt("0"),
    timeUnixNano: BigInt("0"),
    count: BigInt("0"),
    sum: undefined,
    scale: 0,
    zeroCount: BigInt("0"),
    positive: undefined,
    negative: undefined,
    flags: 0,
    exemplars: [],
    min: undefined,
    max: undefined,
    zeroThreshold: 0,
  };
}

export const ExponentialHistogramDataPoint = {
  encode(message: ExponentialHistogramDataPoint, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.attributes) {
      KeyValue.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    if (message.startTimeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.startTimeUnixNano) !== message.startTimeUnixNano) {
        throw new globalThis.Error("value provided for field message.startTimeUnixNano of type fixed64 too large");
      }
      writer.uint32(17).fixed64(message.startTimeUnixNano.toString());
    }
    if (message.timeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.timeUnixNano) !== message.timeUnixNano) {
        throw new globalThis.Error("value provided for field message.timeUnixNano of type fixed64 too large");
      }
      writer.uint32(25).fixed64(message.timeUnixNano.toString());
    }
    if (message.count !== BigInt("0")) {
      if (BigInt.asUintN(64, message.count) !== message.count) {
        throw new globalThis.Error("value provided for field message.count of type fixed64 too large");
      }
      writer.uint32(33).fixed64(message.count.toString());
    }
    if (message.sum !== undefined) {
      writer.uint32(41).double(message.sum);
    }
    if (message.scale !== 0) {
      writer.uint32(48).sint32(message.scale);
    }
    if (message.zeroCount !== BigInt("0")) {
      if (BigInt.asUintN(64, message.zeroCount) !== message.zeroCount) {
        throw new globalThis.Error("value provided for field message.zeroCount of type fixed64 too large");
      }
      writer.uint32(57).fixed64(message.zeroCount.toString());
    }
    if (message.positive !== undefined) {
      ExponentialHistogramDataPoint_Buckets.encode(message.positive, writer.uint32(66).fork()).ldelim();
    }
    if (message.negative !== undefined) {
      ExponentialHistogramDataPoint_Buckets.encode(message.negative, writer.uint32(74).fork()).ldelim();
    }
    if (message.flags !== 0) {
      writer.uint32(80).uint32(message.flags);
    }
    for (const v of message.exemplars) {
      Exemplar.encode(v!, writer.uint32(90).fork()).ldelim();
    }
    if (message.min !== undefined) {
      writer.uint32(97).double(message.min);
    }
    if (message.max !== undefined) {
      writer.uint32(105).double(message.max);
    }
    if (message.zeroThreshold !== 0) {
      writer.uint32(113).double(message.zeroThreshold);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExponentialHistogramDataPoint {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExponentialHistogramDataPoint();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.attributes.push(KeyValue.decode(reader, reader.uint32()));
          continue;
        case 2:
          if (tag !== 17) {
            break;
          }

          message.startTimeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 3:
          if (tag !== 25) {
            break;
          }

          message.timeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 4:
          if (tag !== 33) {
            break;
          }

          message.count = longToBigint(reader.fixed64() as Long);
          continue;
        case 5:
          if (tag !== 41) {
            break;
          }

          message.sum = reader.double();
          continue;
        case 6:
          if (tag !== 48) {
            break;
          }

          message.scale = reader.sint32();
          continue;
        case 7:
          if (tag !== 57) {
            break;
          }

          message.zeroCount = longToBigint(reader.fixed64() as Long);
          continue;
        case 8:
          if (tag !== 66) {
            break;
          }

          message.positive = ExponentialHistogramDataPoint_Buckets.decode(reader, reader.uint32());
          continue;
        case 9:
          if (tag !== 74) {
            break;
          }

          message.negative = ExponentialHistogramDataPoint_Buckets.decode(reader, reader.uint32());
          continue;
        case 10:
          if (tag !== 80) {
            break;
          }

          message.flags = reader.uint32();
          continue;
        case 11:
          if (tag !== 90) {
            break;
          }

          message.exemplars.push(Exemplar.decode(reader, reader.uint32()));
          continue;
        case 12:
          if (tag !== 97) {
            break;
          }

          message.min = reader.double();
          continue;
        case 13:
          if (tag !== 105) {
            break;
          }

          message.max = reader.double();
          continue;
        case 14:
          if (tag !== 113) {
            break;
          }

          message.zeroThreshold = reader.double();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ExponentialHistogramDataPoint {
    return {
      attributes: globalThis.Array.isArray(object?.attributes)
        ? object.attributes.map((e: any) => KeyValue.fromJSON(e))
        : [],
      startTimeUnixNano: isSet(object.startTimeUnixNano) ? BigInt(object.startTimeUnixNano) : BigInt("0"),
      timeUnixNano: isSet(object.timeUnixNano) ? BigInt(object.timeUnixNano) : BigInt("0"),
      count: isSet(object.count) ? BigInt(object.count) : BigInt("0"),
      sum: isSet(object.sum) ? globalThis.Number(object.sum) : undefined,
      scale: isSet(object.scale) ? globalThis.Number(object.scale) : 0,
      zeroCount: isSet(object.zeroCount) ? BigInt(object.zeroCount) : BigInt("0"),
      positive: isSet(object.positive) ? ExponentialHistogramDataPoint_Buckets.fromJSON(object.positive) : undefined,
      negative: isSet(object.negative) ? ExponentialHistogramDataPoint_Buckets.fromJSON(object.negative) : undefined,
      flags: isSet(object.flags) ? globalThis.Number(object.flags) : 0,
      exemplars: globalThis.Array.isArray(object?.exemplars)
        ? object.exemplars.map((e: any) => Exemplar.fromJSON(e))
        : [],
      min: isSet(object.min) ? globalThis.Number(object.min) : undefined,
      max: isSet(object.max) ? globalThis.Number(object.max) : undefined,
      zeroThreshold: isSet(object.zeroThreshold) ? globalThis.Number(object.zeroThreshold) : 0,
    };
  },

  toJSON(message: ExponentialHistogramDataPoint): unknown {
    const obj: any = {};
    if (message.attributes?.length) {
      obj.attributes = message.attributes.map((e) => KeyValue.toJSON(e));
    }
    if (message.startTimeUnixNano !== BigInt("0")) {
      obj.startTimeUnixNano = message.startTimeUnixNano.toString();
    }
    if (message.timeUnixNano !== BigInt("0")) {
      obj.timeUnixNano = message.timeUnixNano.toString();
    }
    if (message.count !== BigInt("0")) {
      obj.count = message.count.toString();
    }
    if (message.sum !== undefined) {
      obj.sum = message.sum;
    }
    if (message.scale !== 0) {
      obj.scale = Math.round(message.scale);
    }
    if (message.zeroCount !== BigInt("0")) {
      obj.zeroCount = message.zeroCount.toString();
    }
    if (message.positive !== undefined) {
      obj.positive = ExponentialHistogramDataPoint_Buckets.toJSON(message.positive);
    }
    if (message.negative !== undefined) {
      obj.negative = ExponentialHistogramDataPoint_Buckets.toJSON(message.negative);
    }
    if (message.flags !== 0) {
      obj.flags = Math.round(message.flags);
    }
    if (message.exemplars?.length) {
      obj.exemplars = message.exemplars.map((e) => Exemplar.toJSON(e));
    }
    if (message.min !== undefined) {
      obj.min = message.min;
    }
    if (message.max !== undefined) {
      obj.max = message.max;
    }
    if (message.zeroThreshold !== 0) {
      obj.zeroThreshold = message.zeroThreshold;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExponentialHistogramDataPoint>, I>>(base?: I): ExponentialHistogramDataPoint {
    return ExponentialHistogramDataPoint.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExponentialHistogramDataPoint>, I>>(
    object: I,
  ): ExponentialHistogramDataPoint {
    const message = createBaseExponentialHistogramDataPoint();
    message.attributes = object.attributes?.map((e) => KeyValue.fromPartial(e)) || [];
    message.startTimeUnixNano = object.startTimeUnixNano ?? BigInt("0");
    message.timeUnixNano = object.timeUnixNano ?? BigInt("0");
    message.count = object.count ?? BigInt("0");
    message.sum = object.sum ?? undefined;
    message.scale = object.scale ?? 0;
    message.zeroCount = object.zeroCount ?? BigInt("0");
    message.positive = (object.positive !== undefined && object.positive !== null)
      ? ExponentialHistogramDataPoint_Buckets.fromPartial(object.positive)
      : undefined;
    message.negative = (object.negative !== undefined && object.negative !== null)
      ? ExponentialHistogramDataPoint_Buckets.fromPartial(object.negative)
      : undefined;
    message.flags = object.flags ?? 0;
    message.exemplars = object.exemplars?.map((e) => Exemplar.fromPartial(e)) || [];
    message.min = object.min ?? undefined;
    message.max = object.max ?? undefined;
    message.zeroThreshold = object.zeroThreshold ?? 0;
    return message;
  },
};

function createBaseExponentialHistogramDataPoint_Buckets(): ExponentialHistogramDataPoint_Buckets {
  return { offset: 0, bucketCounts: [] };
}

export const ExponentialHistogramDataPoint_Buckets = {
  encode(message: ExponentialHistogramDataPoint_Buckets, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.offset !== 0) {
      writer.uint32(8).sint32(message.offset);
    }
    writer.uint32(18).fork();
    for (const v of message.bucketCounts) {
      if (BigInt.asUintN(64, v) !== v) {
        throw new globalThis.Error("a value provided in array field bucketCounts of type uint64 is too large");
      }
      writer.uint64(v.toString());
    }
    writer.ldelim();
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ExponentialHistogramDataPoint_Buckets {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExponentialHistogramDataPoint_Buckets();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.offset = reader.sint32();
          continue;
        case 2:
          if (tag === 16) {
            message.bucketCounts.push(longToBigint(reader.uint64() as Long));

            continue;
          }

          if (tag === 18) {
            const end2 = reader.uint32() + reader.pos;
            while (reader.pos < end2) {
              message.bucketCounts.push(longToBigint(reader.uint64() as Long));
            }

            continue;
          }

          break;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ExponentialHistogramDataPoint_Buckets {
    return {
      offset: isSet(object.offset) ? globalThis.Number(object.offset) : 0,
      bucketCounts: globalThis.Array.isArray(object?.bucketCounts)
        ? object.bucketCounts.map((e: any) => BigInt(e))
        : [],
    };
  },

  toJSON(message: ExponentialHistogramDataPoint_Buckets): unknown {
    const obj: any = {};
    if (message.offset !== 0) {
      obj.offset = Math.round(message.offset);
    }
    if (message.bucketCounts?.length) {
      obj.bucketCounts = message.bucketCounts.map((e) => e.toString());
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ExponentialHistogramDataPoint_Buckets>, I>>(
    base?: I,
  ): ExponentialHistogramDataPoint_Buckets {
    return ExponentialHistogramDataPoint_Buckets.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ExponentialHistogramDataPoint_Buckets>, I>>(
    object: I,
  ): ExponentialHistogramDataPoint_Buckets {
    const message = createBaseExponentialHistogramDataPoint_Buckets();
    message.offset = object.offset ?? 0;
    message.bucketCounts = object.bucketCounts?.map((e) => e) || [];
    return message;
  },
};

function createBaseSummaryDataPoint(): SummaryDataPoint {
  return {
    attributes: [],
    startTimeUnixNano: BigInt("0"),
    timeUnixNano: BigInt("0"),
    count: BigInt("0"),
    sum: 0,
    quantileValues: [],
    flags: 0,
  };
}

export const SummaryDataPoint = {
  encode(message: SummaryDataPoint, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.attributes) {
      KeyValue.encode(v!, writer.uint32(58).fork()).ldelim();
    }
    if (message.startTimeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.startTimeUnixNano) !== message.startTimeUnixNano) {
        throw new globalThis.Error("value provided for field message.startTimeUnixNano of type fixed64 too large");
      }
      writer.uint32(17).fixed64(message.startTimeUnixNano.toString());
    }
    if (message.timeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.timeUnixNano) !== message.timeUnixNano) {
        throw new globalThis.Error("value provided for field message.timeUnixNano of type fixed64 too large");
      }
      writer.uint32(25).fixed64(message.timeUnixNano.toString());
    }
    if (message.count !== BigInt("0")) {
      if (BigInt.asUintN(64, message.count) !== message.count) {
        throw new globalThis.Error("value provided for field message.count of type fixed64 too large");
      }
      writer.uint32(33).fixed64(message.count.toString());
    }
    if (message.sum !== 0) {
      writer.uint32(41).double(message.sum);
    }
    for (const v of message.quantileValues) {
      SummaryDataPoint_ValueAtQuantile.encode(v!, writer.uint32(50).fork()).ldelim();
    }
    if (message.flags !== 0) {
      writer.uint32(64).uint32(message.flags);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): SummaryDataPoint {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseSummaryDataPoint();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 7:
          if (tag !== 58) {
            break;
          }

          message.attributes.push(KeyValue.decode(reader, reader.uint32()));
          continue;
        case 2:
          if (tag !== 17) {
            break;
          }

          message.startTimeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 3:
          if (tag !== 25) {
            break;
          }

          message.timeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 4:
          if (tag !== 33) {
            break;
          }

          message.count = longToBigint(reader.fixed64() as Long);
          continue;
        case 5:
          if (tag !== 41) {
            break;
          }

          message.sum = reader.double();
          continue;
        case 6:
          if (tag !== 50) {
            break;
          }

          message.quantileValues.push(SummaryDataPoint_ValueAtQuantile.decode(reader, reader.uint32()));
          continue;
        case 8:
          if (tag !== 64) {
            break;
          }

          message.flags = reader.uint32();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): SummaryDataPoint {
    return {
      attributes: globalThis.Array.isArray(object?.attributes)
        ? object.attributes.map((e: any) => KeyValue.fromJSON(e))
        : [],
      startTimeUnixNano: isSet(object.startTimeUnixNano) ? BigInt(object.startTimeUnixNano) : BigInt("0"),
      timeUnixNano: isSet(object.timeUnixNano) ? BigInt(object.timeUnixNano) : BigInt("0"),
      count: isSet(object.count) ? BigInt(object.count) : BigInt("0"),
      sum: isSet(object.sum) ? globalThis.Number(object.sum) : 0,
      quantileValues: globalThis.Array.isArray(object?.quantileValues)
        ? object.quantileValues.map((e: any) => SummaryDataPoint_ValueAtQuantile.fromJSON(e))
        : [],
      flags: isSet(object.flags) ? globalThis.Number(object.flags) : 0,
    };
  },

  toJSON(message: SummaryDataPoint): unknown {
    const obj: any = {};
    if (message.attributes?.length) {
      obj.attributes = message.attributes.map((e) => KeyValue.toJSON(e));
    }
    if (message.startTimeUnixNano !== BigInt("0")) {
      obj.startTimeUnixNano = message.startTimeUnixNano.toString();
    }
    if (message.timeUnixNano !== BigInt("0")) {
      obj.timeUnixNano = message.timeUnixNano.toString();
    }
    if (message.count !== BigInt("0")) {
      obj.count = message.count.toString();
    }
    if (message.sum !== 0) {
      obj.sum = message.sum;
    }
    if (message.quantileValues?.length) {
      obj.quantileValues = message.quantileValues.map((e) => SummaryDataPoint_ValueAtQuantile.toJSON(e));
    }
    if (message.flags !== 0) {
      obj.flags = Math.round(message.flags);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<SummaryDataPoint>, I>>(base?: I): SummaryDataPoint {
    return SummaryDataPoint.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<SummaryDataPoint>, I>>(object: I): SummaryDataPoint {
    const message = createBaseSummaryDataPoint();
    message.attributes = object.attributes?.map((e) => KeyValue.fromPartial(e)) || [];
    message.startTimeUnixNano = object.startTimeUnixNano ?? BigInt("0");
    message.timeUnixNano = object.timeUnixNano ?? BigInt("0");
    message.count = object.count ?? BigInt("0");
    message.sum = object.sum ?? 0;
    message.quantileValues = object.quantileValues?.map((e) => SummaryDataPoint_ValueAtQuantile.fromPartial(e)) || [];
    message.flags = object.flags ?? 0;
    return message;
  },
};

function createBaseSummaryDataPoint_ValueAtQuantile(): SummaryDataPoint_ValueAtQuantile {
  return { quantile: 0, value: 0 };
}

export const SummaryDataPoint_ValueAtQuantile = {
  encode(message: SummaryDataPoint_ValueAtQuantile, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.quantile !== 0) {
      writer.uint32(9).double(message.quantile);
    }
    if (message.value !== 0) {
      writer.uint32(17).double(message.value);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): SummaryDataPoint_ValueAtQuantile {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseSummaryDataPoint_ValueAtQuantile();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 9) {
            break;
          }

          message.quantile = reader.double();
          continue;
        case 2:
          if (tag !== 17) {
            break;
          }

          message.value = reader.double();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): SummaryDataPoint_ValueAtQuantile {
    return {
      quantile: isSet(object.quantile) ? globalThis.Number(object.quantile) : 0,
      value: isSet(object.value) ? globalThis.Number(object.value) : 0,
    };
  },

  toJSON(message: SummaryDataPoint_ValueAtQuantile): unknown {
    const obj: any = {};
    if (message.quantile !== 0) {
      obj.quantile = message.quantile;
    }
    if (message.value !== 0) {
      obj.value = message.value;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<SummaryDataPoint_ValueAtQuantile>, I>>(
    base?: I,
  ): SummaryDataPoint_ValueAtQuantile {
    return SummaryDataPoint_ValueAtQuantile.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<SummaryDataPoint_ValueAtQuantile>, I>>(
    object: I,
  ): SummaryDataPoint_ValueAtQuantile {
    const message = createBaseSummaryDataPoint_ValueAtQuantile();
    message.quantile = object.quantile ?? 0;
    message.value = object.value ?? 0;
    return message;
  },
};

function createBaseExemplar(): Exemplar {
  return {
    filteredAttributes: [],
    timeUnixNano: BigInt("0"),
    asDouble: undefined,
    asInt: undefined,
    spanId: Buffer.alloc(0),
    traceId: Buffer.alloc(0),
  };
}

export const Exemplar = {
  encode(message: Exemplar, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.filteredAttributes) {
      KeyValue.encode(v!, writer.uint32(58).fork()).ldelim();
    }
    if (message.timeUnixNano !== BigInt("0")) {
      if (BigInt.asUintN(64, message.timeUnixNano) !== message.timeUnixNano) {
        throw new globalThis.Error("value provided for field message.timeUnixNano of type fixed64 too large");
      }
      writer.uint32(17).fixed64(message.timeUnixNano.toString());
    }
    if (message.asDouble !== undefined) {
      writer.uint32(25).double(message.asDouble);
    }
    if (message.asInt !== undefined) {
      if (BigInt.asIntN(64, message.asInt) !== message.asInt) {
        throw new globalThis.Error("value provided for field message.asInt of type sfixed64 too large");
      }
      writer.uint32(49).sfixed64(message.asInt.toString());
    }
    if (message.spanId.length !== 0) {
      writer.uint32(34).bytes(message.spanId);
    }
    if (message.traceId.length !== 0) {
      writer.uint32(42).bytes(message.traceId);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Exemplar {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseExemplar();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 7:
          if (tag !== 58) {
            break;
          }

          message.filteredAttributes.push(KeyValue.decode(reader, reader.uint32()));
          continue;
        case 2:
          if (tag !== 17) {
            break;
          }

          message.timeUnixNano = longToBigint(reader.fixed64() as Long);
          continue;
        case 3:
          if (tag !== 25) {
            break;
          }

          message.asDouble = reader.double();
          continue;
        case 6:
          if (tag !== 49) {
            break;
          }

          message.asInt = longToBigint(reader.sfixed64() as Long);
          continue;
        case 4:
          if (tag !== 34) {
            break;
          }

          message.spanId = reader.bytes() as Buffer;
          continue;
        case 5:
          if (tag !== 42) {
            break;
          }

          message.traceId = reader.bytes() as Buffer;
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Exemplar {
    return {
      filteredAttributes: globalThis.Array.isArray(object?.filteredAttributes)
        ? object.filteredAttributes.map((e: any) => KeyValue.fromJSON(e))
        : [],
      timeUnixNano: isSet(object.timeUnixNano) ? BigInt(object.timeUnixNano) : BigInt("0"),
      asDouble: isSet(object.asDouble) ? globalThis.Number(object.asDouble) : undefined,
      asInt: isSet(object.asInt) ? BigInt(object.asInt) : undefined,
      spanId: isSet(object.spanId) ? Buffer.from(bytesFromBase64(object.spanId)) : Buffer.alloc(0),
      traceId: isSet(object.traceId) ? Buffer.from(bytesFromBase64(object.traceId)) : Buffer.alloc(0),
    };
  },

  toJSON(message: Exemplar): unknown {
    const obj: any = {};
    if (message.filteredAttributes?.length) {
      obj.filteredAttributes = message.filteredAttributes.map((e) => KeyValue.toJSON(e));
    }
    if (message.timeUnixNano !== BigInt("0")) {
      obj.timeUnixNano = message.timeUnixNano.toString();
    }
    if (message.asDouble !== undefined) {
      obj.asDouble = message.asDouble;
    }
    if (message.asInt !== undefined) {
      obj.asInt = message.asInt.toString();
    }
    if (message.spanId.length !== 0) {
      obj.spanId = base64FromBytes(message.spanId);
    }
    if (message.traceId.length !== 0) {
      obj.traceId = base64FromBytes(message.traceId);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Exemplar>, I>>(base?: I): Exemplar {
    return Exemplar.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Exemplar>, I>>(object: I): Exemplar {
    const message = createBaseExemplar();
    message.filteredAttributes = object.filteredAttributes?.map((e) => KeyValue.fromPartial(e)) || [];
    message.timeUnixNano = object.timeUnixNano ?? BigInt("0");
    message.asDouble = object.asDouble ?? undefined;
    message.asInt = object.asInt ?? undefined;
    message.spanId = object.spanId ?? Buffer.alloc(0);
    message.traceId = object.traceId ?? Buffer.alloc(0);
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
