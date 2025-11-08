"""
Core execution types and task run result schemas.

These schemas match TypeScript types in:
packages/core/src/v3/schemas/common.ts
"""

from typing import Any, Dict, Literal, Optional
from pydantic import BaseModel, Field

from trigger_sdk.schemas.errors import TaskRunError


class TaskRunExecutionUsage(BaseModel):
    """Task execution usage metrics"""
    durationMs: int


class TaskRunExecutionRetry(BaseModel):
    """Task retry information"""
    timestamp: int  # Unix timestamp
    delay: int  # Delay in milliseconds


class TaskInfo(BaseModel):
    """Basic task information"""
    id: str
    filePath: str


class RunInfo(BaseModel):
    """Task run information"""
    id: str
    payload: str  # JSON-serialized payload
    payloadType: str
    tags: list[str] = Field(default_factory=list)
    isTest: bool = False


class AttemptInfo(BaseModel):
    """Task attempt information"""
    id: str
    number: int
    startedAt: str  # ISO 8601 timestamp


# Progressive expansion fields - to be implemented later
class OrganizationInfo(BaseModel):
    """Organization context (TODO: expand)"""
    id: str
    slug: str
    name: str


class ProjectInfo(BaseModel):
    """Project context (TODO: expand)"""
    id: str
    ref: str
    slug: str
    name: str


class EnvironmentInfo(BaseModel):
    """Environment context (TODO: expand)"""
    id: str
    slug: str
    type: Literal["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"]


class QueueInfo(BaseModel):
    """Queue context (TODO: expand)"""
    id: str
    name: str


class DeploymentInfo(BaseModel):
    """Deployment context (TODO: expand)"""
    id: str
    shortCode: str
    version: str


class BatchInfo(BaseModel):
    """Batch execution context"""
    id: str


class TaskRunExecution(BaseModel):
    """
    Complete task execution context.

    Progressive design: Essential fields required, optional fields for future expansion.
    Maps to TypeScript TaskRunExecution schema.
    """
    # Essential fields (MVP)
    task: TaskInfo
    run: RunInfo
    attempt: AttemptInfo

    # Optional fields for progressive expansion
    # TODO: Make these required once coordinator integration is complete
    batch: Optional[BatchInfo] = None
    queue: Optional[QueueInfo] = None
    organization: Optional[OrganizationInfo] = None
    project: Optional[ProjectInfo] = None
    environment: Optional[EnvironmentInfo] = None
    deployment: Optional[DeploymentInfo] = None


class TaskRunSuccessfulExecutionResult(BaseModel):
    """
    Successful task execution result.

    Maps to TypeScript TaskRunSuccessfulExecutionResult.
    Returned when task completes successfully.
    """
    ok: Literal[True] = True
    id: str  # Run ID from execution context
    output: Optional[str] = None  # JSON-serialized output
    outputType: str = "application/json"
    usage: Optional[TaskRunExecutionUsage] = None
    taskIdentifier: Optional[str] = None  # For backwards compatibility
    # Note: Skipping metadata/flushedMetadata for MVP


class TaskRunFailedExecutionResult(BaseModel):
    """
    Failed task execution result.

    Maps to TypeScript TaskRunFailedExecutionResult.
    Returned when task fails with an error.
    """
    ok: Literal[False] = False
    id: str  # Run ID from execution context
    error: TaskRunError
    retry: Optional[TaskRunExecutionRetry] = None
    skippedRetrying: Optional[bool] = None
    usage: Optional[TaskRunExecutionUsage] = None
    taskIdentifier: Optional[str] = None  # For backwards compatibility
    # Note: Skipping metadata/flushedMetadata for MVP


# Type alias for result discriminated union
TaskRunExecutionResult = TaskRunSuccessfulExecutionResult | TaskRunFailedExecutionResult
