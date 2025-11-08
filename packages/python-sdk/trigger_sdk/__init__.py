"""Trigger.dev Python SDK v3"""

from trigger_sdk.task import task, Task, TASK_REGISTRY
from trigger_sdk.types import TaskConfig, RetryConfig, QueueConfig

__version__ = "0.1.0"
__all__ = [
    "task",
    "Task",
    "TASK_REGISTRY",
    "TaskConfig",
    "RetryConfig",
    "QueueConfig",
]
