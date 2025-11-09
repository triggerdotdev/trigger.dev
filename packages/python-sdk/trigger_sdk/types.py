"""Type definitions for the Python SDK"""

from typing import Optional
from pydantic import BaseModel


class RetryConfig(BaseModel):
    """Task retry configuration"""
    maxAttempts: int = 3
    minTimeoutInMs: int = 1000
    maxTimeoutInMs: int = 60000
    factor: float = 2.0
    randomize: bool = True


class QueueConfig(BaseModel):
    """Task queue configuration"""
    name: Optional[str] = None
    concurrencyLimit: Optional[int] = None


class TaskConfig(BaseModel):
    """Task configuration"""
    id: str
    retry: Optional[RetryConfig] = None
    queue: Optional[QueueConfig] = None
    maxDuration: Optional[int] = None  # milliseconds (converted from seconds in decorator)


class TaskMetadata(BaseModel):
    """Task metadata for registration"""
    id: str
    filePath: str
    exportName: str
    retry: Optional[RetryConfig] = None
    queue: Optional[QueueConfig] = None
    maxDuration: Optional[int] = None
