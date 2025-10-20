# Realtime Streams Testing Guide

## Overview

This app is set up to test Trigger.dev realtime streams with resume/reconnection functionality.

## How It Works

### 1. Home Page (`/`)

- Displays buttons for different stream scenarios
- Each button triggers a server action that:
  1. Starts a new task run
  2. Redirects to `/runs/[runId]?accessToken=xxx`

### 2. Run Page (`/runs/[runId]`)

- Displays the live stream for a specific run
- Receives `runId` from URL path parameter
- Receives `accessToken` from URL query parameter
- Shows real-time streaming content using `useRealtimeRunWithStreams`

## Testing Resume/Reconnection

### Test Scenario 1: Page Refresh

1. Click any stream button (e.g., "Markdown Stream")
2. Watch the stream start
3. **Refresh the page** (Cmd/Ctrl + R)
4. The stream should reconnect and continue from where it left off

### Test Scenario 2: Network Interruption

1. Start a long-running stream (e.g., "Stall Stream")
2. Open DevTools → Network tab
3. Throttle to "Offline" briefly
4. Return to "Online"
5. Stream should recover and resume

### Test Scenario 3: URL Navigation

1. Start a stream
2. Copy the URL
3. Open in a new tab
4. Both tabs should show the same stream state

## Available Stream Scenarios

- **Markdown Stream**: Fast streaming of formatted markdown (good for quick tests)
- **Continuous Stream**: 45 seconds of continuous word streaming
- **Burst Stream**: 10 bursts of rapid tokens with pauses
- **Stall Stream**: 3-minute test with long pauses (tests timeout handling)
- **Slow Steady Stream**: 5-minute slow stream (tests long connections)

## What to Watch For

1. **Resume functionality**: After refresh, does the stream continue or restart?
2. **No duplicate data**: Reconnection should not repeat already-seen chunks
3. **Console logs**: Check for `[MetadataStream]` logs showing resume behavior
4. **Run status**: Status should update correctly (EXECUTING → COMPLETED)
5. **Token count**: Final token count should be accurate (no missing chunks)

## Debugging

Check browser console for:

- `[MetadataStream]` logs showing HEAD requests and resume logic
- Network requests to `/realtime/v1/streams/...`
- Any errors or warnings

Check server logs for:

- Stream ingestion logs
- Resume header values (`X-Resume-From-Chunk`, `X-Last-Chunk-Index`)
