"""Task execution context"""

from typing import Any, Dict, Optional
from contextvars import ContextVar

from trigger_sdk.schemas.common import (
    TaskInfo,
    RunInfo,
    AttemptInfo,
    BatchInfo,
    TaskRunExecution,
)

# Context variable for current task execution
_current_context: ContextVar[Optional["TaskContext"]] = ContextVar(
    "current_task_context", default=None
)


class TaskContext:
    """
    Context object available during task execution.

    Provides access to task metadata, run info, and utilities.
    """

    def __init__(
        self,
        task: TaskInfo,
        run: RunInfo,
        attempt: AttemptInfo,
        batch: Optional[BatchInfo] = None,
        environment: Optional[Dict[str, Any]] = None,
    ):
        self.task = task
        self.run = run
        self.attempt = attempt
        self.batch = batch
        self.environment = environment or {}

    @classmethod
    def from_execution_payload(cls, execution: TaskRunExecution) -> "TaskContext":
        """Create context from execution message payload"""
        # Convert EnvironmentInfo to dict for MVP
        env_dict = {}
        if execution.environment:
            env_dict = execution.environment.model_dump()

        return cls(
            task=execution.task,
            run=execution.run,
            attempt=execution.attempt,
            batch=execution.batch,
            environment=env_dict,
        )

    @property
    def is_retry(self) -> bool:
        """Check if this is a retry attempt"""
        return self.attempt.number > 1

    def __repr__(self) -> str:
        return f"TaskContext(task={self.task.id}, run={self.run.id}, attempt={self.attempt.number})"


def get_current_context() -> Optional[TaskContext]:
    """Get the current task context (if inside a task execution)"""
    return _current_context.get()


def set_current_context(context: TaskContext) -> None:
    """Set the current task context (called by worker)"""
    _current_context.set(context)


def clear_current_context() -> None:
    """Clear the current task context"""
    _current_context.set(None)
