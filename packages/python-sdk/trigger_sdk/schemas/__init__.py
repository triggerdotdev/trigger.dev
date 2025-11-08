"""
Pydantic message schemas for Python SDK.

Matches TypeScript Zod schemas in packages/core/src/v3/schemas/
"""

from trigger_sdk.schemas.common import (
    TaskRunExecutionUsage,
    TaskRunExecutionRetry,
    TaskInfo,
    RunInfo,
    AttemptInfo,
    BatchInfo,
    OrganizationInfo,
    ProjectInfo,
    EnvironmentInfo,
    QueueInfo,
    DeploymentInfo,
    TaskRunExecution,
    TaskRunSuccessfulExecutionResult,
    TaskRunFailedExecutionResult,
    TaskRunExecutionResult,
)

from trigger_sdk.schemas.errors import (
    TaskRunErrorCode,
    TaskRunBuiltInError,
    TaskRunInternalError,
    TaskRunStringError,
    TaskRunError,
)

from trigger_sdk.schemas.messages import (
    TaskRunCompletedMessage,
    TaskRunFailedMessage,
    TaskHeartbeatMessage,
    IndexTasksCompleteMessage,
    WorkerMessage,
    ExecuteTaskRunMessage,
    CancelMessage,
    FlushMessage,
    CoordinatorMessage,
)

from trigger_sdk.schemas.resources import (
    QueueConfig,
    RetryConfig,
    TaskResource,
)

__all__ = [
    # Common
    "TaskRunExecutionUsage",
    "TaskRunExecutionRetry",
    "TaskInfo",
    "RunInfo",
    "AttemptInfo",
    "BatchInfo",
    "OrganizationInfo",
    "ProjectInfo",
    "EnvironmentInfo",
    "QueueInfo",
    "DeploymentInfo",
    "TaskRunExecution",
    "TaskRunSuccessfulExecutionResult",
    "TaskRunFailedExecutionResult",
    "TaskRunExecutionResult",
    # Errors
    "TaskRunErrorCode",
    "TaskRunBuiltInError",
    "TaskRunInternalError",
    "TaskRunStringError",
    "TaskRunError",
    # Messages
    "TaskRunCompletedMessage",
    "TaskRunFailedMessage",
    "TaskHeartbeatMessage",
    "IndexTasksCompleteMessage",
    "WorkerMessage",
    "ExecuteTaskRunMessage",
    "CancelMessage",
    "FlushMessage",
    "CoordinatorMessage",
    # Resources
    "QueueConfig",
    "RetryConfig",
    "TaskResource",
]
