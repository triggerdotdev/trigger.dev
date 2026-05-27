# AI Chat Architecture

## System Overview

```mermaid
graph TB
    subgraph Frontend["Frontend (Browser)"]
        UC[useChat Hook]
        TCT[TriggerChatTransport]
        UI[Chat UI Components]
    end

    subgraph Platform["Trigger.dev Platform"]
        API[REST API]
        RS[Realtime Streams]
        RE[Run Engine]
    end

    subgraph Worker["Task Worker"]
        CT[chat.task Turn Loop]
        ST[streamText / AI SDK]
        LLM[LLM Provider]
        SUB[Subtasks via ai.tool]
    end

    UI -->|user types| UC
    UC -->|sendMessages| TCT
    TCT -->|triggerTask / sendInputStream| API
    API -->|queue run / deliver input| RE
    RE -->|execute| CT
    CT -->|call| ST
    ST -->|API call| LLM
    LLM -->|stream chunks| ST
    ST -->|UIMessageChunks| RS
    RS -->|SSE| TCT
    TCT -->|ReadableStream| UC
    UC -->|update| UI
    CT -->|triggerAndWait| SUB
    SUB -->|chat.stream target:root| RS
```

## Detailed Flow: New Chat (First Message)

```mermaid
sequenceDiagram
    participant User
    participant useChat as useChat + Transport
    participant API as Trigger.dev API
    participant Task as chat.task Worker
    participant LLM as LLM Provider

    User->>useChat: sendMessage("Hello")
    useChat->>useChat: No session for chatId → trigger new run

    useChat->>API: triggerTask(payload, tags: [chat:id])
    API-->>useChat: { runId, publicAccessToken }
    useChat->>useChat: Store session, subscribe to SSE

    API->>Task: Start run with ChatTaskWirePayload

    Note over Task: Preload phase skipped (trigger ≠ "preload")

    rect rgb(240, 248, 255)
        Note over Task: Turn 0
        Task->>Task: convertToModelMessages(uiMessages)
        Task->>Task: Mint access token
        Task->>Task: onChatStart({ chatId, messages, clientData })
        Task->>Task: onTurnStart({ chatId, messages, uiMessages })
        Task->>LLM: streamText({ model, messages, abortSignal })
        LLM-->>Task: Stream response chunks
        Task->>API: streams.pipe("chat", uiStream)
        API-->>useChat: SSE: UIMessageChunks
        useChat-->>User: Render streaming text
        Task->>Task: onFinish → capturedResponseMessage
        Task->>Task: Accumulate response in messages
        Task->>API: Write __trigger_turn_complete chunk
        API-->>useChat: SSE: { type: __trigger_turn_complete, publicAccessToken }
        useChat->>useChat: Close stream, update session
        Task->>Task: onTurnComplete({ messages, uiMessages, stopped })
    end

    rect rgb(255, 248, 240)
        Note over Task: Wait for next message
        Task->>Task: messagesInput.once() [warm, 30s]
        Note over Task: No message → suspend
        Task->>Task: messagesInput.wait() [suspended, 1h]
    end
```

## Detailed Flow: Multi-Turn (Subsequent Messages)

```mermaid
sequenceDiagram
    participant User
    participant useChat as useChat + Transport
    participant API as Trigger.dev API
    participant Task as chat.task Worker
    participant LLM as LLM Provider

    Note over Task: Suspended, waiting for message

    User->>useChat: sendMessage("Tell me more")
    useChat->>useChat: Session exists → send via input stream
    useChat->>API: sendInputStream(runId, "chat-messages", payload)
    Note right of useChat: Only sends new message<br/>(not full history)

    API->>Task: Deliver to messagesInput
    Task->>Task: Wake from suspend

    rect rgb(240, 248, 255)
        Note over Task: Turn 1
        Task->>Task: Append new message to accumulators
        Task->>Task: Mint fresh access token
        Task->>Task: onTurnStart({ turn: 1, messages })
        Task->>LLM: streamText({ messages: [all accumulated] })
        LLM-->>Task: Stream response
        Task->>API: streams.pipe("chat", uiStream)
        API-->>useChat: SSE: UIMessageChunks
        useChat-->>User: Render streaming text
        Task->>API: Write __trigger_turn_complete
        Task->>Task: onTurnComplete({ turn: 1 })
    end

    Task->>Task: Wait for next message (warm → suspend)
```

## Stop Signal Flow

```mermaid
sequenceDiagram
    participant User
    participant useChat as useChat + Transport
    participant API as Trigger.dev API
    participant Task as chat.task Worker
    participant LLM as LLM Provider

    Note over Task: Streaming response...

    User->>useChat: Click "Stop"
    useChat->>API: sendInputStream(runId, "chat-stop", { stop: true })
    useChat->>useChat: Set skipToTurnComplete = true

    API->>Task: Deliver to stopInput
    Task->>Task: stopController.abort()
    Task->>LLM: AbortSignal fires
    LLM-->>Task: Stream ends (AbortError)
    Task->>Task: Catch AbortError, fall through
    Task->>Task: await onFinishPromise (race condition fix)
    Task->>Task: cleanupAbortedParts(responseMessage)
    Note right of Task: Remove partial tool calls<br/>Mark streaming parts as done

    Task->>API: Write __trigger_turn_complete
    API-->>useChat: SSE: __trigger_turn_complete
    useChat->>useChat: skipToTurnComplete = false, close stream

    Task->>Task: onTurnComplete({ stopped: true, responseMessage: cleaned })
    Task->>Task: Wait for next message
```

## Preload Flow

```mermaid
sequenceDiagram
    participant User
    participant useChat as useChat + Transport
    participant API as Trigger.dev API
    participant Task as chat.task Worker

    User->>useChat: Click "New Chat"
    useChat->>API: transport.preload(chatId)
    Note right of useChat: payload: { messages: [], trigger: "preload" }<br/>tags: [chat:id, preload:true]
    API-->>useChat: { runId, publicAccessToken }
    useChat->>useChat: Store session

    API->>Task: Start run (trigger = "preload")

    rect rgb(240, 255, 240)
        Note over Task: Preload Phase
        Task->>Task: Mint access token
        Task->>Task: onPreload({ chatId, clientData })
        Note right of Task: DB setup, load user context,<br/>load dynamic tools
        Task->>Task: messagesInput.once() [warm]
        Note over Task: Waiting for first message...
    end

    Note over User: User is typing...

    User->>useChat: sendMessage("Hello")
    useChat->>useChat: Session exists → send via input stream
    useChat->>API: sendInputStream(runId, "chat-messages", payload)
    API->>Task: Deliver message

    rect rgb(240, 248, 255)
        Note over Task: Turn 0 (preloaded = true)
        Task->>Task: onChatStart({ preloaded: true })
        Task->>Task: onTurnStart({ preloaded: true })
        Task->>Task: run() with preloaded dynamic tools ready
    end
```

## Subtask Streaming (Tool as Task)

```mermaid
sequenceDiagram
    participant useChat as useChat + Transport
    participant API as Trigger.dev API
    participant Chat as chat.task
    participant LLM as LLM Provider
    participant Sub as Subtask (ai.tool)

    Chat->>LLM: streamText({ tools: { research: ai.tool(task) } })
    LLM-->>Chat: Tool call: research({ query, urls })

    Chat->>API: triggerAndWait(subtask, input)
    Note right of Chat: Passes toolCallId, chatId,<br/>clientData via metadata

    API->>Sub: Start subtask

    Sub->>Sub: ai.chatContextOrThrow() → { chatId, clientData }
    Sub->>API: chat.stream.writer({ target: "root" })
    Note right of Sub: Write data-research-progress<br/>chunks to parent's stream
    API-->>useChat: SSE: data-* chunks
    useChat-->>useChat: Render progress UI

    Sub-->>Chat: Return result
    Chat->>LLM: Tool result
    LLM-->>Chat: Continue response
```

## Continuation Flow (Run Timeout / Cancel)

```mermaid
sequenceDiagram
    participant User
    participant useChat as useChat + Transport
    participant API as Trigger.dev API
    participant Task as chat.task Worker

    Note over Task: Previous run timed out / was cancelled

    User->>useChat: sendMessage("Continue")
    useChat->>API: sendInputStream(runId, payload)
    API-->>useChat: Error (run dead)

    useChat->>useChat: Delete session, set isContinuation = true
    useChat->>API: triggerTask(payload, continuation: true, previousRunId)
    API-->>useChat: New { runId, publicAccessToken }

    API->>Task: Start new run

    rect rgb(255, 245, 238)
        Note over Task: Turn 0 (continuation = true)
        Task->>Task: cleanupAbortedParts(incoming messages)
        Note right of Task: Strip incomplete tool calls<br/>from previous run's response
        Task->>Task: onChatStart({ continuation: true, previousRunId })
        Task->>Task: Normal turn flow...
    end
```

## Hook Lifecycle

```mermaid
graph TD
    START([Run Starts]) --> IS_PRELOAD{trigger = preload?}

    IS_PRELOAD -->|Yes| PRELOAD[onPreload]
    PRELOAD --> WAIT_MSG[Wait for first message<br/>warm → suspend]
    WAIT_MSG --> TURN0

    IS_PRELOAD -->|No| TURN0

    TURN0[Turn 0] --> CHAT_START[onChatStart<br/>continuation, preloaded]
    CHAT_START --> TURN_START_0[onTurnStart]
    TURN_START_0 --> RUN_0[run → streamText]
    RUN_0 --> TURN_COMPLETE_0[onTurnComplete<br/>stopped, responseMessage]

    TURN_COMPLETE_0 --> WAIT{Wait for<br/>next message}
    WAIT -->|Message arrives| TURN_N[Turn N]
    WAIT -->|Timeout| END_RUN([Run Ends])

    TURN_N --> TURN_START_N[onTurnStart]
    TURN_START_N --> RUN_N[run → streamText]
    RUN_N --> TURN_COMPLETE_N[onTurnComplete]
    TURN_COMPLETE_N --> WAIT
```

## Stream Architecture

```mermaid
graph LR
    subgraph Output["Output Stream (chat)"]
        direction TB
        O1[UIMessageChunks<br/>text, reasoning, tools]
        O2[data-* custom chunks]
        O3[__trigger_turn_complete<br/>control chunk]
    end

    subgraph Input["Input Streams"]
        direction TB
        I1[chat-messages<br/>User messages]
        I2[chat-stop<br/>Stop signal]
    end

    Frontend -->|sendInputStream| I1
    Frontend -->|sendInputStream| I2
    I1 -->|messagesInput.once/wait| Worker
    I2 -->|stopInput.on| Worker
    Worker -->|streams.pipe / chat.stream| Output
    Subtask -->|chat.stream target:root| Output
    Output -->|SSE /realtime/v1/streams| Frontend
```
