"""
Task resource schemas for indexing and metadata.

These schemas match TypeScript TaskResource in:
packages/core/src/v3/schemas/resources.ts
"""

from typing import Optional
from pydantic import BaseModel


class QueueConfig(BaseModel):
    """Queue configuration for a task"""
    name: Optional[str] = None
    concurrencyLimit: Optional[int] = None


class RetryConfig(BaseModel):
    """Retry configuration for a task"""
    maxAttempts: Optional[int] = None
    factor: Optional[float] = None
    minTimeoutInMs: Optional[int] = None
    maxTimeoutInMs: Optional[int] = None
    randomize: Optional[bool] = None


class TaskResource(BaseModel):
    """
    Task metadata for indexing.

    Sent to coordinator during task discovery/indexing phase.
    Maps to TypeScript TaskResource schema.
    """
    id: str
    filePath: str
    exportName: str  # Python uses task ID as export name
    description: Optional[str] = None
    queue: Optional[QueueConfig] = None
    retry: Optional[RetryConfig] = None
    maxDuration: Optional[int] = None  # In seconds

    # TODO: Add in future iterations
    # machine: Optional[MachineConfig] = None
    # triggerSource: Optional[str] = None
    # schedule: Optional[ScheduleMetadata] = None
    # payloadSchema: Optional[dict] = None
