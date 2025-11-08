"""
Abstract IPC connection interface for transport independence.

Allows multiple transport implementations:
- StdioIpcConnection (line-delimited JSON over stdio)
- GrpcIpcConnection (future: gRPC streaming)
- WebSocketIpcConnection (future: WebSocket transport)
"""

import json
from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, Optional, Union
import traceback

from trigger_sdk.schemas.messages import (
    WorkerMessage,
    CoordinatorMessage,
    TaskRunCompletedMessage,
    TaskRunFailedMessage,
    TaskHeartbeatMessage,
)
from trigger_sdk.schemas.common import (
    TaskRunSuccessfulExecutionResult,
    TaskRunFailedExecutionResult,
    TaskRunExecutionUsage,
)


class IpcConnection(ABC):
    """
    Abstract IPC connection interface.

    Implementations must provide transport-specific message sending/receiving
    while maintaining the same high-level API for task workers.
    """

    @abstractmethod
    async def send(self, message: WorkerMessage) -> None:
        """
        Send a message to the coordinator.

        Args:
            message: Worker message to send (discriminated union type)

        Raises:
            Exception: If sending fails (implementation-specific)
        """
        pass

    @abstractmethod
    async def start_listening(self) -> None:
        """
        Start receiving messages from the coordinator.

        This should be a long-running method that continuously listens for
        incoming messages and dispatches them to registered handlers.

        Implementations should handle errors gracefully and not crash on
        malformed messages.
        """
        pass

    @abstractmethod
    def on(self, message_type: str, handler: Callable[[Any], Any]) -> None:
        """
        Register a handler for a specific message type.

        Args:
            message_type: Message type to handle (e.g., "EXECUTE_TASK_RUN")
            handler: Callable that receives the message
                    Can be sync or async function
        """
        pass

    @abstractmethod
    def stop(self) -> None:
        """
        Stop the connection gracefully.

        Should clean up resources and stop listening for messages.
        """
        pass

    # ========================================================================
    # Convenience methods (concrete implementations using abstract methods)
    # ========================================================================

    async def send_completed(
        self,
        id: str,
        output: Any,
        usage: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Send TASK_RUN_COMPLETED message.

        Args:
            id: Run ID from execution context
            output: Task result (will be JSON-serialized if not string)
            usage: Optional usage metrics (durationMs, etc.)
        """
        # Serialize output to JSON string
        if not isinstance(output, str):
            output_str = json.dumps(output)
        else:
            output_str = output

        # Create usage object if provided
        usage_obj = None
        if usage:
            usage_obj = TaskRunExecutionUsage(**usage)

        # Create success result
        result = TaskRunSuccessfulExecutionResult(
            id=id,
            output=output_str,
            outputType="application/json",
            usage=usage_obj,
        )

        # Create and send message
        message = TaskRunCompletedMessage.from_result(result)
        await self.send(message)

    async def send_failed(
        self,
        id: str,
        error: Exception,
        usage: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Send TASK_RUN_FAILED_TO_RUN message.

        Args:
            id: Run ID from execution context
            error: Exception that caused the failure
            usage: Optional usage metrics
        """
        # Import here to avoid circular dependency
        from trigger_sdk.errors import exception_to_task_run_error

        # Convert exception to TaskRunError schema
        error_obj = exception_to_task_run_error(error)

        # Create usage object if provided
        usage_obj = None
        if usage:
            usage_obj = TaskRunExecutionUsage(**usage)

        # Create failure result
        result = TaskRunFailedExecutionResult(
            id=id,
            error=error_obj,
            usage=usage_obj,
        )

        # Create and send message
        message = TaskRunFailedMessage.from_result(result)
        await self.send(message)

    async def send_heartbeat(self, id: str) -> None:
        """
        Send TASK_HEARTBEAT message.

        Args:
            id: Run or attempt ID
        """
        message = TaskHeartbeatMessage(id=id)
        await self.send(message)
