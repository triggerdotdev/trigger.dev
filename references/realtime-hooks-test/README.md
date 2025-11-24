# Realtime Hooks Test Reference Project

This is a comprehensive testing reference project for the `@trigger.dev/react-hooks` package. It demonstrates all the realtime hooks available in `useRealtime.ts`.

## Hooks Tested

This project includes examples for:

- ✅ `useRealtimeRun` - Subscribe to a single task run
- ✅ `useRealtimeRunWithStreams` - Subscribe to a run with stream data
- ✅ `useRealtimeRunsWithTag` - Subscribe to multiple runs by tag
- ✅ `useRealtimeBatch` - Subscribe to a batch of runs
- ✅ `useRealtimeStream` - Subscribe to a specific stream

## Getting Started

### 1. Install dependencies

From the repository root:

```bash
pnpm install
```

### 2. Set up environment variables

Create a `.env.local` file:

```bash
TRIGGER_SECRET_KEY=your_secret_key
TRIGGER_PROJECT_REF=your_project_ref
NEXT_PUBLIC_TRIGGER_PUBLIC_KEY=your_public_key
NEXT_PUBLIC_TRIGGER_API_URL=http://localhost:3030
```

### 3. Run the development servers

In one terminal, run the Trigger.dev dev server:

```bash
pnpm run dev:trigger
```

In another terminal, run the Next.js dev server:

```bash
pnpm run dev
```

### 4. Open the app

Visit [http://localhost:3000](http://localhost:3000) to see the examples.

## Project Structure

```
src/
├── app/
│   ├── page.tsx                    # Home page with navigation
│   ├── actions.ts                  # Server actions for triggering tasks
│   ├── run/[id]/page.tsx          # useRealtimeRun example
│   ├── run-with-streams/[id]/page.tsx  # useRealtimeRunWithStreams example
│   ├── runs-with-tag/[tag]/page.tsx    # useRealtimeRunsWithTag example
│   ├── batch/[id]/page.tsx        # useRealtimeBatch example
│   └── stream/[id]/page.tsx       # useRealtimeStream example
├── components/
│   ├── run-viewer.tsx             # Component using useRealtimeRun
│   ├── run-with-streams-viewer.tsx # Component using useRealtimeRunWithStreams
│   ├── runs-with-tag-viewer.tsx   # Component using useRealtimeRunsWithTag
│   ├── batch-viewer.tsx           # Component using useRealtimeBatch
│   └── stream-viewer.tsx          # Component using useRealtimeStream
└── trigger/
    ├── simple-task.ts             # Simple task for useRealtimeRun
    ├── stream-task.ts             # Task with streams for useRealtimeRunWithStreams
    ├── tagged-task.ts             # Tasks that use tags
    └── batch-task.ts              # Tasks for batch operations
```

## Testing Scenarios

Each page demonstrates different aspects of the hooks:

### 1. Single Run (`/run/[id]`)
- Basic subscription to a single run
- onComplete callback
- stopOnCompletion option
- Error handling

### 2. Run with Streams (`/run-with-streams/[id]`)
- Subscribe to run updates and multiple streams
- Throttling stream updates
- Type-safe stream data

### 3. Runs with Tag (`/runs-with-tag/[tag]`)
- Subscribe to multiple runs by tag
- Real-time updates as new runs are created
- createdAt filtering

### 4. Batch (`/batch/[id]`)
- Subscribe to all runs in a batch
- Track batch progress
- Individual run statuses

### 5. Stream (`/stream/[id]`)
- Subscribe to a specific stream
- Start from specific index
- onData callback for each chunk
- Timeout handling

