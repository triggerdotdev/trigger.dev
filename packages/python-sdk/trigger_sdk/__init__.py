"""Trigger.dev Python SDK v3"""

from trigger_sdk.task import task, Task, TASK_REGISTRY
from trigger_sdk.types import TaskConfig, RetryConfig, QueueConfig
from trigger_sdk.ipc import IpcConnection, GrpcIpcConnection
from trigger_sdk.schemas.messages import WorkerMessage, CoordinatorMessage
from trigger_sdk.schemas.common import TaskRunExecution
from trigger_sdk.context import TaskContext, get_current_context
from trigger_sdk.logger import logger

__version__ = "0.1.0"
__all__ = [
    # Task decorator and registry
    "task",
    "Task",
    "TASK_REGISTRY",
    # Configuration types
    "TaskConfig",
    "RetryConfig",
    "QueueConfig",
    # IPC layer
    "IpcConnection",
    "GrpcIpcConnection",
    # Message types
    "WorkerMessage",
    "CoordinatorMessage",
    # Execution context
    "TaskRunExecution",
    "TaskContext",
    "get_current_context",
    # Logging
    "logger",
]
