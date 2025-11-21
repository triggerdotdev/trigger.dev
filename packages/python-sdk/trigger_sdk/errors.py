"""
Exception to TaskRunError conversion utilities.

Maps Python exceptions to Trigger.dev error schemas for consistent
error reporting across languages.
"""

import traceback
from typing import Optional

from trigger_sdk.schemas.errors import (
    TaskRunError,
    TaskRunErrorCode,
    TaskRunBuiltInError,
    TaskRunInternalError,
    TaskRunStringError,
)


def exception_to_task_run_error(exc: Exception) -> TaskRunError:
    """
    Convert Python exception to TaskRunError schema.

    Preserves stack traces and maps exceptions to appropriate error types:
    - Built-in Python exceptions → TaskRunBuiltInError
    - System/import errors → TaskRunInternalError with error code
    - Unknown exceptions → TaskRunStringError (fallback)

    Args:
        exc: Python exception to convert

    Returns:
        TaskRunError schema object (discriminated union)
    """
    # Get stack trace
    stack_trace = traceback.format_exc()

    # Try to map to error code
    error_code = get_error_code_for_exception(exc)

    # Built-in Python exceptions
    if isinstance(exc, (
        TypeError,
        ValueError,
        AttributeError,
        KeyError,
        IndexError,
        RuntimeError,
        AssertionError,
        ZeroDivisionError,
        NameError,
        FileNotFoundError,
        PermissionError,
        TimeoutError,
    )):
        return TaskRunBuiltInError(
            type="BUILT_IN_ERROR",
            name=exc.__class__.__name__,
            message=str(exc),
            stackTrace=stack_trace,
        )

    # Internal/system errors with error codes
    if error_code:
        return TaskRunInternalError(
            type="INTERNAL_ERROR",
            code=error_code,
            message=str(exc),
            stackTrace=stack_trace,
        )

    # Fallback: string error for unknown exceptions
    return TaskRunStringError(
        type="STRING_ERROR",
        raw=f"{exc.__class__.__name__}: {str(exc)}\n{stack_trace}",
    )


def get_error_code_for_exception(exc: Exception) -> Optional[TaskRunErrorCode]:
    """
    Map Python exception types to TaskRunErrorCode enum.

    Args:
        exc: Python exception

    Returns:
        Error code string if mapped, None otherwise
    """
    # Import errors
    if isinstance(exc, (ImportError, ModuleNotFoundError)):
        return "COULD_NOT_IMPORT_TASK"

    # Process exit errors
    if isinstance(exc, SystemExit):
        return "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE"

    # Cancellation errors
    if isinstance(exc, (KeyboardInterrupt, asyncio.CancelledError)):
        return "TASK_RUN_CANCELLED"

    # Syntax/parsing errors
    if isinstance(exc, (SyntaxError, IndentationError)):
        return "TASK_INPUT_ERROR"

    # Timeout errors
    if isinstance(exc, TimeoutError):
        return "MAX_DURATION_EXCEEDED"

    # Serialization errors (often from JSON encoding/decoding)
    if isinstance(exc, (json.JSONDecodeError, UnicodeError)):
        return "TASK_OUTPUT_ERROR"

    # Generic fallback
    return "TASK_EXECUTION_FAILED"


# Import asyncio and json for type checking
import asyncio
import json
