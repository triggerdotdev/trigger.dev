"""
gRPC-based IPC connection for Python workers.

Implements the IpcConnection interface using gRPC for communication
with the coordinator.
"""

import os
import asyncio
import sys
import traceback
import logging
from typing import Any, Callable, Dict, Optional
from concurrent.futures import ThreadPoolExecutor

import grpc

from trigger_sdk.ipc.base import IpcConnection
from trigger_sdk.schemas.messages import (
    WorkerMessage,
    CoordinatorMessage,
    TaskRunCompletedMessage,
    TaskRunFailedMessage,
    TaskHeartbeatMessage,
    IndexTasksCompleteMessage,
    LogMessage,
    ExecuteTaskRunMessage,
    CancelMessage,
    FlushMessage,
)
from trigger_sdk.schemas.common import (
    TaskRunSuccessfulExecutionResult,
    TaskRunFailedExecutionResult,
)
from trigger_sdk.schemas.errors import TaskRunError, TaskRunInternalError
from trigger_sdk.generated import worker_pb2, worker_pb2_grpc

# Get logger for debug output
_logger = logging.getLogger(__name__)


class GrpcIpcConnection(IpcConnection):
    """
    gRPC-based IPC connection.

    Connects to the coordinator's gRPC server via Unix socket or TCP.
    Compatible with the same interface as StdioIpcConnection.
    """

    def __init__(
        self,
        address: Optional[str] = None,
    ):
        """
        Initialize gRPC IPC connection.

        Args:
            address: gRPC server address (unix:/path/to/socket or localhost:port)
                     If None, reads from TRIGGER_GRPC_ADDRESS env var
        """
        super().__init__()

        self.address = address or os.environ.get("TRIGGER_GRPC_ADDRESS")
        if not self.address:
            raise ValueError(
                "gRPC address not provided. Set TRIGGER_GRPC_ADDRESS environment variable "
                "or pass address parameter."
            )

        self.channel: Optional[grpc.aio.Channel] = None
        self.stub: Optional[worker_pb2_grpc.WorkerServiceStub] = None
        self.stream: Optional[grpc.aio.StreamStreamCall] = None
        self._send_queue: asyncio.Queue = asyncio.Queue()
        self._running = False
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._handlers: Dict[str, Callable] = {}

    def on(self, message_type: str, handler: Callable) -> None:
        """Register a message handler"""
        self._handlers[message_type] = handler

    async def _dispatch_message(self, message: CoordinatorMessage):
        """Dispatch message to registered handler"""
        message_type = message.type

        if message_type in self._handlers:
            handler = self._handlers[message_type]

            # Support both sync and async handlers
            if asyncio.iscoroutinefunction(handler):
                await handler(message)
            else:
                handler(message)

    async def connect(self):
        """Establish gRPC connection to coordinator"""
        # Create channel (Unix socket or TCP)
        self.channel = grpc.aio.insecure_channel(self.address)

        # Create stub
        self.stub = worker_pb2_grpc.WorkerServiceStub(self.channel)

        # Start bidirectional stream
        self.stream = self.stub.Connect(self._message_generator())

    async def _message_generator(self):
        """Generator for outgoing messages to coordinator"""
        while self._running or not self._send_queue.empty():
            try:
                # Get message from queue
                pydantic_msg = await asyncio.wait_for(
                    self._send_queue.get(),
                    timeout=1.0
                )

                # Convert Pydantic → Protobuf
                proto_msg = self._pydantic_to_proto(pydantic_msg)

                yield proto_msg

            except asyncio.TimeoutError:
                # Keep generator alive
                continue
            except Exception as e:
                # Log and continue on errors (connection might be closing)
                _logger.debug(f"Error in message generator: {e}")
                continue

    def _pydantic_to_proto(self, message: WorkerMessage) -> worker_pb2.WorkerMessage:
        """Convert Pydantic message to Protobuf"""
        proto_msg = worker_pb2.WorkerMessage()

        if isinstance(message, TaskRunCompletedMessage):
            completion = message.completion
            proto_msg.task_run_completed.type = message.type
            proto_msg.task_run_completed.version = message.version

            result = proto_msg.task_run_completed.completion
            result.id = completion["id"]
            if completion.get("output"):
                result.output = completion["output"]
            result.output_type = completion.get("outputType", "application/json")
            if completion.get("usage"):
                result.usage.duration_ms = completion["usage"].get("durationMs", 0)
            if completion.get("taskIdentifier"):
                result.task_identifier = completion["taskIdentifier"]

        elif isinstance(message, TaskRunFailedMessage):
            completion = message.completion
            proto_msg.task_run_failed.type = message.type
            proto_msg.task_run_failed.version = message.version

            result = proto_msg.task_run_failed.completion
            result.id = completion["id"]

            # Set error
            error_data = completion["error"]
            if error_data.get("type") == "BUILT_IN_ERROR":
                result.error.built_in_error.name = error_data["name"]
                result.error.built_in_error.message = error_data["message"]
                result.error.built_in_error.stack_trace = error_data["stackTrace"]
            elif error_data.get("type") == "INTERNAL_ERROR":
                result.error.internal_error.code = error_data["code"]
                result.error.internal_error.message = error_data.get("message", "")
                result.error.internal_error.stack_trace = error_data.get("stackTrace", "")
            elif error_data.get("type") == "STRING_ERROR":
                result.error.string_error.raw = error_data["raw"]

            if completion.get("usage"):
                result.usage.duration_ms = completion["usage"].get("durationMs", 0)
            if completion.get("taskIdentifier"):
                result.task_identifier = completion["taskIdentifier"]

        elif isinstance(message, TaskHeartbeatMessage):
            proto_msg.task_heartbeat.type = message.type
            proto_msg.task_heartbeat.version = message.version
            proto_msg.task_heartbeat.id = message.id

        elif isinstance(message, IndexTasksCompleteMessage):
            proto_msg.index_tasks_complete.type = message.type
            proto_msg.index_tasks_complete.version = message.version
            for task in message.tasks:
                task_meta = proto_msg.index_tasks_complete.tasks.add()
                for key, value in task.items():
                    task_meta.fields[key] = str(value)

        elif isinstance(message, LogMessage):
            proto_msg.log.type = message.type
            proto_msg.log.version = message.version
            proto_msg.log.level = int(message.level)
            proto_msg.log.message = message.message
            proto_msg.log.logger = message.logger
            proto_msg.log.timestamp = message.timestamp
            if message.exception:
                proto_msg.log.exception = message.exception

        return proto_msg

    def _proto_to_pydantic(self, proto_msg: worker_pb2.CoordinatorMessage) -> CoordinatorMessage:
        """Convert Protobuf message to Pydantic"""
        # Check which oneof field is set
        which = proto_msg.WhichOneof("message")

        if which == "execute_task_run":
            exec_msg = proto_msg.execute_task_run
            execution_dict = self._proto_execution_to_dict(exec_msg.execution)
            return ExecuteTaskRunMessage(
                type=exec_msg.type,
                version=exec_msg.version,
                execution=execution_dict
            )
        elif which == "cancel":
            return CancelMessage(
                type=proto_msg.cancel.type,
                version=proto_msg.cancel.version
            )
        elif which == "flush":
            return FlushMessage(
                type=proto_msg.flush.type,
                version=proto_msg.flush.version
            )

        raise ValueError(f"Unknown coordinator message type: {which}")

    def _proto_execution_to_dict(self, execution: worker_pb2.TaskRunExecution) -> Dict[str, Any]:
        """Convert TaskRunExecution protobuf to dict for Pydantic validation"""
        result = {
            "task": {
                "id": execution.task.id,
                "filePath": execution.task.file_path,
            },
            "run": {
                "id": execution.run.id,
                "payload": execution.run.payload,
                "payloadType": execution.run.payload_type,
                "tags": list(execution.run.tags),
                "isTest": execution.run.is_test,
            },
            "attempt": {
                "id": execution.attempt.id,
                "number": execution.attempt.number,
                "startedAt": execution.attempt.started_at,
            },
        }

        # Optional fields
        if execution.HasField("batch"):
            result["batch"] = {"id": execution.batch.id}
        if execution.HasField("queue"):
            result["queue"] = {"id": execution.queue.id, "name": execution.queue.name}
        if execution.HasField("organization"):
            result["organization"] = {
                "id": execution.organization.id,
                "slug": execution.organization.slug,
                "name": execution.organization.name,
            }
        if execution.HasField("project"):
            result["project"] = {
                "id": execution.project.id,
                "ref": execution.project.ref,
                "slug": execution.project.slug,
                "name": execution.project.name,
            }
        if execution.HasField("environment"):
            result["environment"] = {
                "id": execution.environment.id,
                "slug": execution.environment.slug,
                "type": worker_pb2.EnvironmentType.Name(execution.environment.type),
            }
        if execution.HasField("deployment"):
            result["deployment"] = {
                "id": execution.deployment.id,
                "shortCode": execution.deployment.short_code,
                "version": execution.deployment.version,
            }

        return result

    async def send(self, message: WorkerMessage):
        """
        Send a message to the coordinator via gRPC.
        """
        if not self._running:
            raise RuntimeError("gRPC connection not started. Call start_listening() first.")

        try:
            # Add message to send queue
            await self._send_queue.put(message)

        except Exception as e:
            # Log and fail - connection might be closing
            _logger.debug(f"Failed to send message: {e}")
            pass

    async def start_listening(self):
        """
        Start listening for messages from the coordinator.

        Connects to gRPC server and processes incoming messages.
        """
        self._running = True

        try:
            # Connect to server
            await self.connect()

            # Listen for incoming messages
            async for proto_msg in self.stream:
                try:
                    # Convert Protobuf → Pydantic
                    message = self._proto_to_pydantic(proto_msg)

                    # Dispatch to handler
                    await self._dispatch_message(message)

                except Exception as e:
                    # Log and continue on message handling errors
                    _logger.debug(f"Error handling message: {e}")
                    pass

        except grpc.aio.AioRpcError as e:
            # Connection closed - this is expected
            _logger.debug(f"gRPC connection closed: {e}")
            pass
        except Exception as e:
            # Fatal error - log and exit
            _logger.debug(f"Fatal error in gRPC listener: {e}")
            pass
        finally:
            self._running = False
            await self.close()

    async def flush(self, timeout: float = 1.0):
        """
        Wait for all pending messages to be sent.

        Args:
            timeout: Maximum time to wait in seconds
        """
        start_time = asyncio.get_event_loop().time()
        while not self._send_queue.empty():
            elapsed = asyncio.get_event_loop().time() - start_time
            if elapsed >= timeout:
                break
            await asyncio.sleep(0.01)

    def stop(self):
        """Stop listening for messages"""
        self._running = False

    async def close(self):
        """Close the gRPC connection"""
        self.stop()

        # Close stream
        if self.stream:
            self.stream.cancel()
            self.stream = None

        # Close channel
        if self.channel:
            await self.channel.close()
            self.channel = None

        # Shutdown executor
        self._executor.shutdown(wait=False)
