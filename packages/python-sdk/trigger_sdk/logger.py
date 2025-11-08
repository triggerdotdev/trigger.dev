"""Structured logging for tasks"""

import json
import sys
from typing import Any
from datetime import datetime, timezone

from trigger_sdk.context import get_current_context


class TaskLogger:
    """
    Structured logger for task execution.

    Logs are sent to stderr with structured metadata.
    """

    def __init__(self, name: str = "trigger"):
        self.name = name

    def _log(self, level: str, message: str, **extra: Any) -> None:
        """Internal log method with structured data"""
        context = get_current_context()

        log_data = {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": level,
            "message": message,
            "logger": self.name,
            **extra,
        }

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
