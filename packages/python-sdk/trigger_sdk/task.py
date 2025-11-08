"""Task decorator and registration"""

import asyncio
import inspect
from typing import Any, Callable, Dict, Optional, TypeVar, Union
from trigger_sdk.types import TaskConfig, TaskMetadata, RetryConfig, QueueConfig

# Global task registry
TASK_REGISTRY: Dict[str, "Task"] = {}

TPayload = TypeVar("TPayload")
TOutput = TypeVar("TOutput")


class Task:
    """Represents a registered task"""

    def __init__(
        self,
        config: TaskConfig,
        run_fn: Callable[[Any], Any],
        file_path: Optional[str] = None,
    ):
        self.id = config.id
        self.config = config
        self.run_fn = run_fn
        self.file_path = file_path or "<unknown>"

        # Validate function signature
        if not (inspect.iscoroutinefunction(run_fn) or inspect.isfunction(run_fn)):
            raise TypeError(f"Task '{self.id}' must be a function or async function")

        # Register task
        if self.id in TASK_REGISTRY:
            raise ValueError(f"Task with id '{self.id}' already registered")

        TASK_REGISTRY[self.id] = self

    async def execute(self, payload: Any) -> Any:
        """Execute the task with the given payload"""
        if inspect.iscoroutinefunction(self.run_fn):
            return await self.run_fn(payload)
        else:
            # Run sync function in executor to avoid blocking
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, self.run_fn, payload)

    def get_metadata(self) -> TaskMetadata:
        """Get task metadata for indexing"""
        return TaskMetadata(
            id=self.id,
            filePath=self.file_path,
            exportName=self.id,  # Python uses ID as export name
            retry=self.config.retry,
            queue=self.config.queue,
            maxDuration=self.config.maxDuration,
        )

    def __repr__(self) -> str:
        return f"Task(id='{self.id}', file='{self.file_path}')"


def task(
    id: str,
    *,
    retry: Optional[Union[RetryConfig, Dict[str, Any]]] = None,
    queue: Optional[Union[QueueConfig, Dict[str, Any]]] = None,
    max_duration: Optional[int] = None,
) -> Callable[[Callable[..., Any]], Task]:
    """
    Decorator to register a task.

    Usage:
        @task("my-task-id", retry={"maxAttempts": 5})
        async def my_task(payload):
            return {"result": "success"}

    Args:
        id: Unique task identifier
        retry: Retry configuration (dict or RetryConfig)
        queue: Queue configuration (dict or QueueConfig)
        max_duration: Maximum task duration in seconds

    Returns:
        Decorated task function as a Task instance
    """
    # Convert dict to models if needed (with None check fix)
    retry_config = RetryConfig(**retry) if isinstance(retry, dict) else retry
    queue_config = QueueConfig(**queue) if isinstance(queue, dict) else queue

    config = TaskConfig(
        id=id,
        retry=retry_config,
        queue=queue_config,
        maxDuration=max_duration,
    )

    def decorator(fn: Callable[..., Any]) -> Task:
        # Get file path from function
        file_path = inspect.getfile(fn) if hasattr(fn, "__code__") else None

        task_obj = Task(config=config, run_fn=fn, file_path=file_path)
        return task_obj

    return decorator


def get_all_tasks() -> Dict[str, Task]:
    """Get all registered tasks"""
    return TASK_REGISTRY.copy()


def clear_registry() -> None:
    """Clear the task registry (useful for testing)"""
    TASK_REGISTRY.clear()
