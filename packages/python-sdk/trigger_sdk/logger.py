"""Structured logging for tasks"""

import json
import sys
import asyncio
from typing import Any, Optional, TYPE_CHECKING
from datetime import datetime, timezone

from trigger_sdk.context import get_current_context

if TYPE_CHECKING:
    from trigger_sdk.ipc.base import IpcConnection


class TaskLogger:
    """
    Structured logger for task execution.

    Logs can be sent via gRPC (when available) or stderr (fallback).
    """

    def __init__(self, name: str = "trigger"):
        self.name = name
        self._ipc_connection: Optional["IpcConnection"] = None

    def set_ipc_connection(self, connection: "IpcConnection") -> None:
        """Set IPC connection for sending logs via gRPC"""
        self._ipc_connection = connection

    def _log(self, level: str, message: str, **extra: Any) -> None:
        """Internal log method with structured data"""
        from trigger_sdk.schemas.messages import LogMessage, LogLevel

        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        exception = extra.pop("exception", None)

        # If gRPC is available and we're in an async context, send via gRPC
        if self._ipc_connection:
            try:
                # Check if connection is still running
                if not hasattr(self._ipc_connection, '_running') or not self._ipc_connection._running:
                    # Connection is closed, fall back to stderr
                    self._log_to_stderr(level, message, timestamp, exception, **extra)
                    return

                # Map string level to enum
                log_level = LogLevel[level]

                log_msg = LogMessage(
                    level=log_level,
                    message=message,
                    logger=self.name,
                    timestamp=timestamp,
                    exception=exception,
                )

                # Try to send async if we're in an event loop
                try:
                    loop = asyncio.get_running_loop()
                    # Schedule the send as a task
                    asyncio.create_task(self._ipc_connection.send(log_msg))
                except RuntimeError:
                    # No event loop running, fall back to stderr
                    self._log_to_stderr(level, message, timestamp, exception, **extra)

            except Exception:
                # If gRPC fails, fall back to stderr silently
                self._log_to_stderr(level, message, timestamp, exception, **extra)
        else:
            # No gRPC connection, use stderr
            self._log_to_stderr(level, message, timestamp, exception, **extra)

    def _log_to_stderr(self, level: str, message: str, timestamp: str, exception: Optional[str] = None, **extra: Any) -> None:
        """Fallback logging to stderr as JSON"""
        context = get_current_context()

        log_data = {
            "timestamp": timestamp,
            "level": level,
            "message": message,
            "logger": self.name,
            **extra,
        }

        if exception:
            log_data["exception"] = exception

        # Add context metadata if available
        if context:
            log_data["task"] = {
                "id": context.task.id,
                "runId": context.run.id,
                "attemptId": context.attempt.id,
                "attemptNumber": context.attempt.number,
            }

        # Write to stderr as JSON
        sys.stderr.write(json.dumps(log_data) + "\n")
        sys.stderr.flush()

    def debug(self, message: str, **extra: Any) -> None:
        """Log debug message"""
        self._log("DEBUG", message, **extra)

    def info(self, message: str, **extra: Any) -> None:
        """Log info message"""
        self._log("INFO", message, **extra)

    def warn(self, message: str, **extra: Any) -> None:
        """Log warning message"""
        self._log("WARN", message, **extra)

    def error(self, message: str, **extra: Any) -> None:
        """Log error message"""
        self._log("ERROR", message, **extra)

    def log(self, level: str, message: str, **extra: Any) -> None:
        """Log with custom level"""
        self._log(level.upper(), message, **extra)


# Global logger instance
logger = TaskLogger("trigger")
