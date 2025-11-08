"""
IPC message schemas for worker-coordinator communication.

These schemas match TypeScript message types in:
packages/core/src/v3/schemas/messages.ts
"""

from typing import Any, Dict, Literal, Union
from pydantic import BaseModel, Field

from trigger_sdk.schemas.common import (
    TaskRunSuccessfulExecutionResult,
    TaskRunFailedExecutionResult,
    TaskRunExecution,
)


# ============================================================================
# Worker → Coordinator Messages
# ============================================================================

class TaskRunCompletedMessage(BaseModel):
    """
    Task execution completed successfully.

    Sent when a task finishes execution without errors.
    """
    type: Literal["TASK_RUN_COMPLETED"] = "TASK_RUN_COMPLETED"
    version: Literal["v1"] = "v1"
    completion: Dict[str, Any]  # TaskRunSuccessfulExecutionResult as dict

    @classmethod
    def from_result(cls, result: TaskRunSuccessfulExecutionResult) -> "TaskRunCompletedMessage":
        """Create message from result object"""
        return cls(completion=result.model_dump())


class TaskRunFailedMessage(BaseModel):
    """
    Task execution failed.

    Sent when a task fails with an error.
    """
    type: Literal["TASK_RUN_FAILED_TO_RUN"] = "TASK_RUN_FAILED_TO_RUN"
    version: Literal["v1"] = "v1"
    completion: Dict[str, Any]  # TaskRunFailedExecutionResult as dict

    @classmethod
    def from_result(cls, result: TaskRunFailedExecutionResult) -> "TaskRunFailedMessage":
        """Create message from result object"""
        return cls(completion=result.model_dump())


class TaskHeartbeatMessage(BaseModel):
    """
    Heartbeat indicating task is still running.

    Sent periodically during long-running task execution.
    """
    type: Literal["TASK_HEARTBEAT"] = "TASK_HEARTBEAT"
    version: Literal["v1"] = "v1"
    id: str  # Run or attempt ID


class IndexTasksCompleteMessage(BaseModel):
    """
    Task indexing completed.

    Sent after discovering and indexing all tasks in the project.
    Contains task catalog with metadata.
    """
    type: Literal["INDEX_TASKS_COMPLETE"] = "INDEX_TASKS_COMPLETE"
    version: Literal["v1"] = "v1"
    tasks: list[Dict[str, Any]]  # List of TaskResource as dicts


# Discriminated union of all worker messages
WorkerMessage = Union[
    TaskRunCompletedMessage,
    TaskRunFailedMessage,
    TaskHeartbeatMessage,
    IndexTasksCompleteMessage,
]


# ============================================================================
# Coordinator → Worker Messages
# ============================================================================

class ExecuteTaskRunMessage(BaseModel):
    """
    Execute a task run.

    Coordinator sends this to worker to start task execution.
    """
    type: Literal["EXECUTE_TASK_RUN"] = "EXECUTE_TASK_RUN"
    version: Literal["v1"] = "v1"
    execution: Dict[str, Any]  # TaskRunExecution as dict

    def get_execution(self) -> TaskRunExecution:
        """Parse execution payload"""
        return TaskRunExecution.model_validate(self.execution)


class CancelMessage(BaseModel):
    """
    Cancel current task run.

    Coordinator sends this to gracefully stop task execution.
    """
    type: Literal["CANCEL"] = "CANCEL"
    version: Literal["v1"] = "v1"


class FlushMessage(BaseModel):
    """
    Flush logs and telemetry.

    Coordinator sends this to ensure logs are sent before shutdown.
    """
    type: Literal["FLUSH"] = "FLUSH"
    version: Literal["v1"] = "v1"


# Discriminated union of all coordinator messages
CoordinatorMessage = Union[
    ExecuteTaskRunMessage,
    CancelMessage,
    FlushMessage,
]
