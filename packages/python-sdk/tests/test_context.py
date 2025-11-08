"""Tests for task context"""

import pytest
from trigger_sdk.context import (
    TaskContext,
    get_current_context,
    set_current_context,
    clear_current_context,
)
from trigger_sdk.schemas.common import (
    TaskInfo,
    RunInfo,
    AttemptInfo,
    BatchInfo,
    TaskRunExecution,
    EnvironmentInfo,
)


def test_create_context():
    """Test creating task context"""
    context = TaskContext(
        task=TaskInfo(id="test-task", filePath="/test.py"),
        run=RunInfo(
            id="run_123",
            payload='{"value": 42}',
            payloadType="application/json",
            tags=[],
            isTest=False,
        ),
        attempt=AttemptInfo(
            id="attempt_123",
            number=1,
            startedAt="2024-01-01T00:00:00Z",
        ),
    )

    assert context.task.id == "test-task"
    assert context.run.id == "run_123"
    assert context.attempt.number == 1
    assert context.is_retry is False


def test_is_retry():
    """Test retry detection"""
    context = TaskContext(
        task=TaskInfo(id="test", filePath="/test.py"),
        run=RunInfo(
            id="r1",
            payload="{}",
            payloadType="json",
            tags=[],
            isTest=False,
        ),
        attempt=AttemptInfo(
            id="a1",
            number=3,
            startedAt="2024-01-01T00:00:00Z",
        ),
    )

    assert context.is_retry is True


def test_context_var():
    """Test context variable get/set"""
    assert get_current_context() is None

    context = TaskContext(
        task=TaskInfo(id="test", filePath="/test.py"),
        run=RunInfo(
            id="r1",
            payload="{}",
            payloadType="json",
            tags=[],
            isTest=False,
        ),
        attempt=AttemptInfo(
            id="a1",
            number=1,
            startedAt="",
        ),
    )

    set_current_context(context)
    assert get_current_context() == context

    clear_current_context()
    assert get_current_context() is None


def test_context_from_execution_payload():
    """Test creating context from TaskRunExecution"""
    execution = TaskRunExecution(
        task=TaskInfo(id="test", filePath="/test.py"),
        run=RunInfo(
            id="run_123",
            payload='{"value": 42}',
            payloadType="application/json",
            tags=[],
            isTest=False,
        ),
        attempt=AttemptInfo(
            id="attempt_123",
            number=1,
            startedAt="2024-01-01T00:00:00Z",
        ),
        batch=BatchInfo(id="batch_123"),
        environment=EnvironmentInfo(
            id="env_123",
            slug="prod",
            type="PRODUCTION",
        ),
    )

    context = TaskContext.from_execution_payload(execution)

    assert context.task.id == "test"
    assert context.run.id == "run_123"
    assert context.attempt.id == "attempt_123"
    assert context.batch is not None
    assert context.batch.id == "batch_123"
    assert context.environment["slug"] == "prod"
    assert context.environment["type"] == "PRODUCTION"


def test_context_from_execution_without_optional_fields():
    """Test creating context from minimal TaskRunExecution"""
    execution = TaskRunExecution(
        task=TaskInfo(id="test", filePath="/test.py"),
        run=RunInfo(
            id="run_123",
            payload='{"value": 42}',
            payloadType="application/json",
        ),
        attempt=AttemptInfo(
            id="attempt_123",
            number=1,
            startedAt="2024-01-01T00:00:00Z",
        ),
    )

    context = TaskContext.from_execution_payload(execution)

    assert context.task.id == "test"
    assert context.batch is None
    assert context.environment == {}


def test_context_repr():
    """Test context string representation"""
    context = TaskContext(
        task=TaskInfo(id="my-task", filePath="/test.py"),
        run=RunInfo(
            id="run_abc",
            payload="{}",
            payloadType="json",
        ),
        attempt=AttemptInfo(
            id="attempt_xyz",
            number=2,
            startedAt="",
        ),
    )

    repr_str = repr(context)
    assert "my-task" in repr_str
    assert "run_abc" in repr_str
    assert "2" in repr_str
