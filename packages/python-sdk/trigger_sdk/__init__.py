"""Trigger.dev Python SDK v3"""

from trigger_sdk.task import task, Task, TASK_REGISTRY
from trigger_sdk.types import TaskConfig, RetryConfig, QueueConfig
from trigger_sdk.ipc import IpcConnection, StdioIpcConnection
from trigger_sdk.schemas.messages import WorkerMessage, CoordinatorMessage
from trigger_sdk.schemas.common import TaskRunExecution

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
    "StdioIpcConnection",
    # Message types
    "WorkerMessage",
    "CoordinatorMessage",
    # Execution context
    "TaskRunExecution",
]
