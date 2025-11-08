"""
TaskRunError types and error code mappings.

These schemas match the TypeScript error types in:
packages/core/src/v3/schemas/common.ts (lines 130-207)
"""

from typing import Literal, Union
from pydantic import BaseModel


# Essential subset of 38 error codes - focused on Python worker lifecycle
TaskRunErrorCode = Literal[
    "COULD_NOT_IMPORT_TASK",
    "TASK_EXECUTION_FAILED",
    "TASK_RUN_CANCELLED",
    "MAX_DURATION_EXCEEDED",
    "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE",
    "TASK_INPUT_ERROR",
    "TASK_OUTPUT_ERROR",
    "INTERNAL_ERROR",
]


class TaskRunBuiltInError(BaseModel):
    """
    Built-in Python exception error.

    Used for standard Python exceptions like TypeError, ValueError, etc.
    Maps to TypeScript BUILT_IN_ERROR type.
    """
    type: Literal["BUILT_IN_ERROR"] = "BUILT_IN_ERROR"
    name: str  # Exception class name (e.g., "TypeError", "ValueError")
    message: str
    stackTrace: str


class TaskRunInternalError(BaseModel):
    """
    Internal system error with specific error code.

    Used for system-level errors during task execution.
    Maps to TypeScript INTERNAL_ERROR type.
    """
    type: Literal["INTERNAL_ERROR"] = "INTERNAL_ERROR"
    code: TaskRunErrorCode
    message: str = ""
    stackTrace: str = ""


class TaskRunStringError(BaseModel):
    """
    Simple string error.

    Used as fallback for errors that don't fit other categories.
    Maps to TypeScript STRING_ERROR type.
    """
    type: Literal["STRING_ERROR"] = "STRING_ERROR"
    raw: str


# Discriminated union of all error types
# Note: Skipping CUSTOM_ERROR for MVP - can be added later
TaskRunError = Union[
    TaskRunBuiltInError,
    TaskRunInternalError,
    TaskRunStringError,
]
