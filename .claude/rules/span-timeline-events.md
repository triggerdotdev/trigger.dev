# Span Timeline Events

The trace view's right panel shows a timeline of events for the selected span. These are OTel span events rendered by `app/utils/timelineSpanEvents.ts` and the `SpanTimeline` component.

## How They Work

1. **Span events** in OTel are attached to a parent span. In ClickHouse, they're stored as separate rows with `kind: "SPAN_EVENT"` sharing the parent span's `span_id`. The `#mergeRecordsIntoSpanDetail` method reassembles them into the span's `events` array at query time.
2. The timeline only renders events whose `name` starts with `trigger.dev/` - all others are silently filtered out.
3. The **display name** comes from `properties.event` (not the span event name), mapped through `getFriendlyNameForEvent()`.
4. Events are shown on the **span they belong to** - events on one span don't appear in another span's timeline.

## ClickHouse Storage Constraint

When events are written to ClickHouse, `spanEventsToTaskEventV1Input()` filters out events whose `start_time` is not greater than the parent span's `startTime`. Events at or before the span start are silently dropped. This means span events must have timestamps strictly after the span's own `startTimeUnixNano`.

## Timeline Rendering (SpanTimeline component)

The `SpanTimeline` component in `app/components/run/RunTimeline.tsx` renders:

1. **Events** (thin 1px line with hollow dots) - all events from `createTimelineSpanEventsFromSpanEvents()`
2. **"Started"** marker (thick cap) - at the span's `startTime`
3. **Duration bar** (thick 7px line) - from "Started" to "Finished"
4. **"Finished"** marker (thick cap) - at `startTime + duration`

The thin line before "Started" only appears when there are events with timestamps between the span start and the first child span. For the Attempt span this works well (Dequeued → Pod scheduled → Launched → etc. all happen before execution starts). Events all get `lineVariant: "light"` (thin) while the execution bar gets `variant: "normal"` (thick).

## Trace View Sort Order

Sibling spans (same parent) are sorted by `start_time ASC` from the ClickHouse query. The `createTreeFromFlatItems` function preserves this order. Event timestamps don't affect sort order - only the span's own `start_time`.

## Event Structure

```typescript
// OTel span event format
{
  name: "trigger.dev/run",        // Must start with "trigger.dev/" to render
  timeUnixNano: "1711200000000000000",
  attributes: [
    { key: "event", value: { stringValue: "dequeue" } },  // The actual event type
    { key: "duration", value: { intValue: 150 } },         // Optional: duration in ms
  ]
}
```

## Admin-Only Events

`getAdminOnlyForEvent()` controls visibility. Events default to **admin-only** (`true`).

| Event | Admin-only | Friendly name |
|-------|-----------|---------------|
| `dequeue` | No | Dequeued |
| `fork` | No | Launched |
| `import` | No (if no fork event) | Importing task file |
| `create_attempt` | Yes | Attempt created |
| `lazy_payload` | Yes | Lazy attempt initialized |
| `pod_scheduled` | Yes | Pod scheduled |
| (default) | Yes | (raw event name) |

## Adding New Timeline Events

1. Add OTLP span event with `name: "trigger.dev/<scope>"` and `properties.event: "<type>"`
2. Event timestamp must be strictly after the parent span's `startTimeUnixNano` (ClickHouse drops earlier events)
3. Add friendly name in `getFriendlyNameForEvent()` in `app/utils/timelineSpanEvents.ts`
4. Set admin visibility in `getAdminOnlyForEvent()`
5. Optionally add help text in `getHelpTextForEvent()`

## Key Files

- `app/utils/timelineSpanEvents.ts` - filtering, naming, admin logic
- `app/components/run/RunTimeline.tsx` - `SpanTimeline` component (thin line + thick bar rendering)
- `app/presenters/v3/SpanPresenter.server.ts` - loads span data including events
- `app/v3/eventRepository/clickhouseEventRepository.server.ts` - `spanEventsToTaskEventV1Input()` (storage filter), `#mergeRecordsIntoSpanDetail` (reassembly)
