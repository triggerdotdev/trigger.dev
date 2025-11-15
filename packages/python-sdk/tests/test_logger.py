"""Tests for structured logging"""

import pytest
import json
from io import StringIO
from unittest.mock import patch
from trigger_sdk.logger import TaskLogger
from trigger_sdk.context import (
    TaskContext,
    set_current_context,
    clear_current_context,
)
from trigger_sdk.schemas.common import TaskInfo, RunInfo, AttemptInfo


def test_logger_basic():
    """Test basic logging"""
    logger = TaskLogger("test")

    with patch("sys.stderr", new=StringIO()) as mock_stderr:
        logger.info("Test message", extra_field="value")

        output = mock_stderr.getvalue()
        log_data = json.loads(output.strip())

        assert log_data["level"] == "INFO"
        assert log_data["message"] == "Test message"
        assert log_data["extra_field"] == "value"
        assert log_data["logger"] == "test"
        assert "timestamp" in log_data


def test_logger_levels():
    """Test different log levels"""
    logger = TaskLogger("test")

    levels = ["DEBUG", "INFO", "WARN", "ERROR"]

    for level in levels:
        with patch("sys.stderr", new=StringIO()) as mock_stderr:
            method = getattr(logger, level.lower())
            method(f"{level} message")

            output = mock_stderr.getvalue()
            log_data = json.loads(output.strip())

            assert log_data["level"] == level
            assert log_data["message"] == f"{level} message"


def test_logger_custom_level():
    """Test custom log level"""
    logger = TaskLogger("test")

    with patch("sys.stderr", new=StringIO()) as mock_stderr:
        logger.log("CUSTOM", "Custom message")

        output = mock_stderr.getvalue()
        log_data = json.loads(output.strip())

        assert log_data["level"] == "CUSTOM"
        assert log_data["message"] == "Custom message"


def test_logger_with_context():
    """Test logging with task context"""
    context = TaskContext(
        task=TaskInfo(id="test-task", filePath="/test.py"),
        run=RunInfo(
            id="run_123",
            payload="{}",
            payloadType="json",
            tags=[],
            isTest=False,
        ),
        attempt=AttemptInfo(
            id="attempt_123",
            number=2,
            startedAt="",
        ),
    )
    set_current_context(context)

    logger = TaskLogger("test")

    with patch("sys.stderr", new=StringIO()) as mock_stderr:
        logger.info("With context")

        output = mock_stderr.getvalue()
        log_data = json.loads(output.strip())

        assert log_data["task"]["id"] == "test-task"
        assert log_data["task"]["runId"] == "run_123"
        assert log_data["task"]["attemptId"] == "attempt_123"
        assert log_data["task"]["attemptNumber"] == 2

    clear_current_context()


def test_logger_without_context():
    """Test logging without task context"""
    clear_current_context()  # Ensure no context
    logger = TaskLogger("test")

    with patch("sys.stderr", new=StringIO()) as mock_stderr:
        logger.info("Without context")

        output = mock_stderr.getvalue()
        log_data = json.loads(output.strip())

        assert "task" not in log_data
        assert log_data["message"] == "Without context"


def test_logger_json_format():
    """Test JSON output format validation"""
    logger = TaskLogger("test")

    with patch("sys.stderr", new=StringIO()) as mock_stderr:
        logger.info("Test", field1="value1", field2=42, field3=True)

        output = mock_stderr.getvalue()
        log_data = json.loads(output.strip())

        # Validate all expected fields
        assert "timestamp" in log_data
        assert "level" in log_data
        assert "message" in log_data
        assert "logger" in log_data
        assert log_data["field1"] == "value1"
        assert log_data["field2"] == 42
        assert log_data["field3"] is True


def test_logger_timestamp_format():
    """Test timestamp format is ISO 8601 with Z suffix"""
    logger = TaskLogger("test")

    with patch("sys.stderr", new=StringIO()) as mock_stderr:
        logger.info("Test timestamp")

        output = mock_stderr.getvalue()
        log_data = json.loads(output.strip())

        timestamp = log_data["timestamp"]
        assert timestamp.endswith("Z")
        assert "T" in timestamp  # ISO 8601 format
