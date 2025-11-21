"""
Stdio-based IPC implementation using line-delimited JSON.

Communicates with Node.js coordinator via stdin/stdout:
- Reads messages from stdin (coordinator → worker)
- Writes messages to stdout (worker → coordinator)
- Logs to stderr (won't interfere with IPC)
"""

import sys
import json
import asyncio
import traceback
from typing import Any, Callable, Dict
from pydantic import ValidationError, TypeAdapter

from trigger_sdk.ipc.base import IpcConnection
from trigger_sdk.schemas.messages import WorkerMessage, CoordinatorMessage

# Create type adapters for union types
_coordinator_message_adapter: TypeAdapter[CoordinatorMessage] = TypeAdapter(CoordinatorMessage)


class StdioIpcConnection(IpcConnection):
    """
    Stdio-based IPC using line-delimited JSON.

    Compatible with Node.js child_process.spawn() stdio communication.
    Thread-safe message sending with async locks.
    """

    def __init__(self) -> None:
        self._handlers: Dict[str, Callable[[Any], Any]] = {}
        self._running = False
        self._stdout_lock = asyncio.Lock()

    def on(self, message_type: str, handler: Callable[[Any], Any]) -> None:
        """Register a message handler"""
        self._handlers[message_type] = handler

    async def send(self, message: WorkerMessage) -> None:
        """
        Send message to stdout as line-delimited JSON.

        Thread-safe using asyncio.Lock to prevent message interleaving.
        Errors are logged to stderr (won't interfere with IPC).
        """
        try:
            # Serialize message to JSON
            json_str = message.model_dump_json()

            # Write to stdout with lock (prevent interleaving)
            async with self._stdout_lock:
                sys.stdout.write(json_str + "\n")
                sys.stdout.flush()

        except Exception as e:
            # Log to stderr (won't interfere with IPC)
            sys.stderr.write(f"[IPC] Failed to send message: {e}\n")
            sys.stderr.flush()

    async def start_listening(self) -> None:
        """
        Read line-delimited JSON from stdin.

        Continuously reads messages and dispatches to registered handlers.
        Handles errors gracefully without crashing:
        - Malformed JSON → logged to stderr, continues
        - Validation errors → logged to stderr, continues
        - Handler exceptions → logged to stderr, continues
        """
        self._running = True
        loop = asyncio.get_event_loop()

        try:
            while self._running:
                # Non-blocking readline using executor
                line = await loop.run_in_executor(None, sys.stdin.readline)

                # Check for EOF
                if not line:
                    break

                line = line.strip()
                if not line:
                    continue

                try:
                    # Parse JSON
                    data = json.loads(line)

                    # Get message type
                    message_type = data.get("type")
                    if not message_type:
                        sys.stderr.write(f"[IPC] Message missing 'type' field: {line}\n")
                        sys.stderr.flush()
                        continue

                    # Validate message schema with Pydantic
                    message = _coordinator_message_adapter.validate_python(data)

                    # Dispatch to registered handler
                    if message_type in self._handlers:
                        handler = self._handlers[message_type]

                        # Support both sync and async handlers
                        if asyncio.iscoroutinefunction(handler):
                            await handler(message)
                        else:
                            handler(message)
                    else:
                        sys.stderr.write(f"[IPC] No handler for message type: {message_type}\n")
                        sys.stderr.flush()

                except json.JSONDecodeError as e:
                    sys.stderr.write(f"[IPC] Invalid JSON: {line}\n")
                    sys.stderr.write(f"[IPC] Error: {e}\n")
                    sys.stderr.flush()

                except ValidationError as e:
                    sys.stderr.write(f"[IPC] Message validation failed: {e}\n")
                    sys.stderr.flush()

                except Exception as e:
                    sys.stderr.write(f"[IPC] Handler error: {e}\n")
                    sys.stderr.write(f"[IPC] Traceback: {traceback.format_exc()}\n")
                    sys.stderr.flush()

        finally:
            self._running = False

    def stop(self) -> None:
        """Stop listening for messages"""
        self._running = False
