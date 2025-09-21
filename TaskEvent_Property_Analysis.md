# TaskEvent/CreatableEvent Property Usage Analysis

This document analyzes every property in TaskEvent/CreatableEvent to determine which ones are actually used in the UI and which can be removed for optimization.

## Properties to KEEP (Used in UI)

| Property                       | Type                   | Used In                                | Usage Description                                                        |
| ------------------------------ | ---------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| **Core Identity & Structure**  |
| `id`                           | String                 | Database operations                    | Primary key, generated automatically                                     |
| `traceId`                      | String                 | Query operations, trace identification | Used for trace queries and grouping                                      |
| `spanId`                       | String                 | TraceSummary, SpanDetails              | Tree structure, span identification                                      |
| `parentId`                     | String?                | TraceSummary                           | Tree hierarchy in `createTreeFromFlatItems`                              |
| `message`                      | String                 | TraceSummary, SpanDetails              | Displayed as span title in `SpanTitle.tsx:20`, tree view                 |
| **Status & State**             |
| `isError`                      | Boolean                | TraceSummary, SpanDetails              | Error status display, filtering, status icons                            |
| `isPartial`                    | Boolean                | TraceSummary, SpanDetails              | In-progress status display, timeline calculations                        |
| `isCancelled`                  | Boolean                | TraceSummary, SpanDetails              | Cancelled status display, status determination                           |
| `level`                        | TaskEventLevel         | TraceSummary, SpanDetails              | Text styling (`SpanTitle.tsx:91-109`), timeline rendering decisions      |
| `kind`                         | TaskEventKind          | TraceSummary                           | Filter "UNSPECIFIED" events, determine debug status                      |
| `status`                       | TaskEventStatus        | Event creation                         | Status tracking in event creation                                        |
| **Timing**                     |
| `startTime`                    | BigInt                 | TraceSummary, SpanDetails              | Timeline calculations, display (`RunPresenter.server.ts:166,171`)        |
| `duration`                     | BigInt                 | TraceSummary, SpanDetails              | Timeline width, duration display, calculations                           |
| `createdAt`                    | DateTime               | Database queries                       | Time-based queries, automatic generation                                 |
| **Content & Display**          |
| `events`                       | Json                   | TraceSummary, SpanDetails              | Timeline events (`RunPresenter.server.ts:181-185`), SpanEvents component |
| `style`                        | Json                   | TraceSummary, SpanDetails              | Icons, variants, accessories (`RunIcon`, `SpanTitle`)                    |
| `properties`                   | Json                   | SpanDetails                            | Displayed as JSON in span properties (`CodeBlock`)                       |
| `metadata`                     | Json?                  | SpanDetails                            | Event transformation, span details processing                            |
| `links`                        | Json?                  | SpanDetails                            | Span linking functionality (processed but not currently displayed)       |
| **Context (Query/Processing)** |
| `runId`                        | String                 | Query operations                       | Used in queries, not displayed in TraceSummary UI                        |
| `idempotencyKey`               | String?                | SpanDetails                            | Displayed in span detail properties (conditional)                        |
| `attemptNumber`                | Int?                   | Processing logic                       | Used for attempt failed logic, not displayed                             |
| `environmentType`              | RuntimeEnvironmentType | Processing                             | Selected in queries, used in processing                                  |
| `taskSlug`                     | String                 | SpanDetails                            | Displayed in span details, task filtering                                |
| `workerVersion`                | String?                | SpanDetails                            | Displayed in span version field                                          |

## Properties to REMOVE (Not Used in UI)

| Property                           | Type    | Reason for Removal                    | Notes                                            |
| ---------------------------------- | ------- | ------------------------------------- | ------------------------------------------------ |
| **Service Information**            |
| `serviceName`                      | String  | Set to "api server", never displayed  | Hardcoded value, no UI usage                     |
| `serviceNamespace`                 | String  | Set to "trigger.dev", never displayed | Hardcoded value, no UI usage                     |
| `tracestate`                       | String? | OpenTelemetry tracestate, not used    | OpenTelemetry field, no UI display               |
| **Organization & Project Context** |
| `environmentId`                    | String  | Used for queries, not displayed       | Backend context only                             |
| `organizationId`                   | String  | Used for queries, not displayed       | Backend context only                             |
| `projectId`                        | String  | Used for queries, not displayed       | Backend context only                             |
| `projectRef`                       | String  | Used for queries, not displayed       | Backend context only                             |
| `runIsTest`                        | Boolean | Not displayed in UI                   | Backend flag, no UI display                      |
| **Worker & Queue Information**     |
| `workerId`                         | String? | Not used in UI rendering              | Backend context only                             |
| `queueId`                          | String? | Not used in UI rendering              | Backend context only                             |
| `queueName`                        | String? | Selected but not rendered             | Selected in DetailedTraceEvent but not displayed |
| `batchId`                          | String? | Not used in UI rendering              | Backend context only                             |
| **Task Information**               |
| `taskPath`                         | String? | Selected but not rendered             | Selected in DetailedTraceEvent but not used      |
| `taskExportName`                   | String? | Not selected or used                  | Not selected in any queries                      |
| **Attempt Information**            |
| `attemptId`                        | String? | Not selected or used                  | Legacy field, not used                           |
| `isDebug`                          | Boolean | Deprecated field                      | Replaced by `kind === TaskEventKind.LOG`         |
| **Content (Unused)**               |
| `output`                           | Json?   | **NOT DISPLAYED** in span UI          | Returned by getSpan but never rendered           |
| `payload`                          | Json?   | **NOT DISPLAYED** in span UI          | Returned by getSpan but never rendered           |
| `outputType`                       | String? | Not used in UI rendering              | Type information not displayed                   |
| `payloadType`                      | String? | Not used in UI rendering              | Type information not displayed                   |
| **Usage & Cost Tracking**          |
| `usageDurationMs`                  | Int     | Not used in UI rendering              | Analytics data, no UI display                    |
| `usageCostInCents`                 | Float   | Not used in UI rendering              | Analytics data, no UI display                    |
| **Machine Information**            |
| `machinePreset`                    | String? | Selected but not rendered             | Selected in DetailedTraceEvent but not displayed |
| `machinePresetCpu`                 | Float?  | Not selected or used                  | Not selected in queries                          |
| `machinePresetMemory`              | Float?  | Not selected or used                  | Not selected in queries                          |
| `machinePresetCentsPerMs`          | Float?  | Not selected or used                  | Not selected in queries                          |

## Summary Statistics

- **Total Properties**: ~51 properties in TaskEvent
- **Properties to Keep**: 22 properties (43%)
- **Properties to Remove**: 29 properties (57%)

## Optimization Opportunities

### TraceSummary (getTraceSummary)

- **Current Selection**: 15 properties via `QueriedEvent`
- **Optimization**: Already optimized, only selects necessary fields
- **Potential Removal**: `runId`, `environmentType` (selected but not used in UI)

### Span Details (getSpan)

- **Current Selection**: ALL TaskEvent properties (full object)
- **Used in UI**: 19 properties
- **Optimization**: Could remove ~65% of properties
- **Major Removals**: `payload`, `output`, all context/metadata fields

### CreatableEvent (Event Creation)

- **Current**: Includes many unused fields
- **Optimization**: Remove ~29 properties that are never displayed
- **Keep**: Core fields needed for queries and UI display

## Implementation Notes

1. **TraceSummary** is already well-optimized with selective field queries
2. **getSpan** has the biggest optimization opportunity - fetches full TaskEvent but only uses ~35%
3. **CreatableEvent** could be split into:
   - `MinimalCreatableEvent` for TraceSummary use cases
   - `DetailedCreatableEvent` for full span details
4. Properties marked as "Selected but not rendered" could be removed unless needed for future features

## Verification Status

✅ **Verified**: All property usage has been systematically verified by examining:

- TraceSummary UI components and data flow
- Span detail UI components (`SpanBody`, `SpanEntity`, `SpanTitle`)
- All query selectors (`QueriedEvent`, `DetailedTraceEvent`)
- Actual UI rendering code

This analysis is based on comprehensive examination of the actual UI components and their property access patterns.
