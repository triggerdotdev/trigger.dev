# @internal/schedule-engine

The `@internal/schedule-engine` package encapsulates all scheduling logic for Trigger.dev, providing a clean API boundary for managing scheduled tasks and their execution.

## Architecture

The ScheduleEngine follows the same pattern as the RunEngine, providing:

- **Centralized Schedule Management**: All schedule-related operations go through the ScheduleEngine
- **Redis Worker Integration**: Built-in Redis-based distributed task scheduling
- **Distributed Execution**: Prevents thundering herd issues by distributing executions across time windows
- **Comprehensive Testing**: Built-in utilities for testing schedule behavior

## Key Components

### ScheduleEngine Class

The main interface for all schedule operations:

```typescript
import { ScheduleEngine } from "@internal/schedule-engine";

const engine = new ScheduleEngine({
  prisma,
  redis: {
    /* Redis configuration */
  },
  worker: {
    /* Worker configuration */
  },
  distributionWindow: { seconds: 30 }, // Optional: default 30s
});

// Register next schedule instance
await engine.registerNextTaskScheduleInstance({ instanceId });

// Upsert a schedule
await engine.upsertTaskSchedule({
  projectId,
  schedule: {
    taskIdentifier: "my-task",
    cron: "0 */5 * * *",
    timezone: "UTC",
    environments: ["env-1", "env-2"],
  },
});
```

### Distributed Scheduling

The engine includes built-in distributed scheduling to prevent all scheduled tasks from executing at exactly the same moment:

```typescript
import { calculateDistributedExecutionTime } from "@internal/schedule-engine";

const exactTime = new Date("2024-01-01T12:00:00Z");
const distributedTime = calculateDistributedExecutionTime(exactTime, 30); // 30-second window
```

### Schedule Calculation

High-performance CRON schedule calculation with optimization for old timestamps:

```typescript
import {
  calculateNextScheduledTimestampFromNow,
  nextScheduledTimestamps,
} from "@internal/schedule-engine";

const nextRun = calculateNextScheduledTimestampFromNow("0 */5 * * *", "UTC");
const upcoming = nextScheduledTimestamps("0 */5 * * *", "UTC", nextRun, 5);
```

## Integration with Webapp

The ScheduleEngine should be the **API boundary** between the webapp and schedule logic. Services in the webapp should call into the ScheduleEngine rather than implementing schedule logic directly.

### Migration Path

Currently, the webapp uses individual services like:

- `RegisterNextTaskScheduleInstanceService`
- `TriggerScheduledTaskService`
- Schedule calculation utilities

These should be replaced with ScheduleEngine method calls:

```typescript
// Old approach
const service = new RegisterNextTaskScheduleInstanceService(tx);
await service.call(instanceId);

// New approach
await scheduleEngine.registerNextTaskScheduleInstance({ instanceId });
```

## Configuration

The ScheduleEngine expects these configuration options:

- `prisma`: PrismaClient instance
- `redis`: Redis connection configuration
- `worker`: Worker configuration (concurrency, polling intervals)
- `distributionWindow`: Optional time window for distributed execution
- `tracer`: Optional OpenTelemetry tracer
- `meter`: Optional OpenTelemetry meter

## Testing

The package includes comprehensive test utilities and examples. See the test directory for usage examples.
