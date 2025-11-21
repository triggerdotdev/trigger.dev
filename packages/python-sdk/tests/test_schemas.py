"""Tests for Pydantic message schemas"""

import json
import pytest
from trigger_sdk.schemas import (
    # Common
    TaskRunExecutionUsage,
    TaskInfo,
    RunInfo,
    AttemptInfo,
    TaskRunExecution,
    TaskRunSuccessfulExecutionResult,
    TaskRunFailedExecutionResult,
    # Errors
    TaskRunBuiltInError,
    TaskRunInternalError,
    TaskRunStringError,
    # Messages
    TaskRunCompletedMessage,
    TaskRunFailedMessage,
    TaskHeartbeatMessage,
    IndexTasksCompleteMessage,
    ExecuteTaskRunMessage,
    CancelMessage,
    FlushMessage,
    # Resources
    TaskResource,
    QueueConfig,
    RetryConfig,
)


class TestCommonSchemas:
    """Test core execution type schemas"""

    def test_task_info_creation(self):
        task = TaskInfo(id="test-task", filePath="/path/to/task.py")
        assert task.id == "test-task"
        assert task.filePath == "/path/to/task.py"

    def test_run_info_defaults(self):
        run = RunInfo(
            id="run_123",
            payload='{"key": "value"}',
            payloadType="application/json",
        )
        assert run.id == "run_123"
        assert run.tags == []
        assert run.isTest is False

    def test_task_run_execution_minimal(self):
        """Test with only essential fields"""
        execution = TaskRunExecution(
            task=TaskInfo(id="task1", filePath="/task.py"),
            run=RunInfo(id="run1", payload="{}", payloadType="application/json"),
            attempt=AttemptInfo(id="attempt1", number=1, startedAt="2024-01-01T00:00:00Z"),
        )
        assert execution.task.id == "task1"
        assert execution.run.id == "run1"
        assert execution.attempt.number == 1
        # Optional fields should be None
        assert execution.organization is None
        assert execution.project is None

    def test_successful_execution_result(self):
        result = TaskRunSuccessfulExecutionResult(
            id="run_123",
            output='{"result": "success"}',
        )
        assert result.ok is True
        assert result.id == "run_123"
        assert result.outputType == "application/json"  # Default

    def test_failed_execution_result(self):
        error = TaskRunBuiltInError(
            name="ValueError",
            message="Invalid input",
            stackTrace="Traceback...",
        )
        result = TaskRunFailedExecutionResult(
            id="run_123",
            error=error,
        )
        assert result.ok is False
        assert result.id == "run_123"
        assert result.error.type == "BUILT_IN_ERROR"


class TestErrorSchemas:
    """Test error type schemas"""

    def test_built_in_error(self):
        error = TaskRunBuiltInError(
            name="TypeError",
            message="Cannot add str and int",
            stackTrace="Traceback (most recent call last):\n  ...",
        )
        assert error.type == "BUILT_IN_ERROR"
        assert error.name == "TypeError"

    def test_internal_error(self):
        error = TaskRunInternalError(
            code="TASK_EXECUTION_FAILED",
            message="Task crashed",
            stackTrace="Traceback...",
        )
        assert error.type == "INTERNAL_ERROR"
        assert error.code == "TASK_EXECUTION_FAILED"

    def test_string_error(self):
        error = TaskRunStringError(raw="Something went wrong")
        assert error.type == "STRING_ERROR"
        assert error.raw == "Something went wrong"

    def test_error_serialization(self):
        """Test that errors serialize to JSON correctly"""
        error = TaskRunBuiltInError(
            name="ValueError",
            message="Test error",
            stackTrace="",
        )
        json_str = error.model_dump_json()
        data = json.loads(json_str)
        assert data["type"] == "BUILT_IN_ERROR"
        assert data["name"] == "ValueError"


class TestWorkerMessages:
    """Test worker → coordinator messages"""

    def test_task_run_completed_message(self):
        result = TaskRunSuccessfulExecutionResult(
            id="run_123",
            output='{"result": "done"}',
        )
        message = TaskRunCompletedMessage.from_result(result)

        assert message.type == "TASK_RUN_COMPLETED"
        assert message.version == "v1"
        assert message.completion["ok"] is True
        assert message.completion["id"] == "run_123"

    def test_task_run_failed_message(self):
        error = TaskRunInternalError(
            code="TASK_EXECUTION_FAILED",
            message="Failed",
        )
        result = TaskRunFailedExecutionResult(
            id="run_123",
            error=error,
        )
        message = TaskRunFailedMessage.from_result(result)

        assert message.type == "TASK_RUN_FAILED_TO_RUN"
        assert message.version == "v1"
        assert message.completion["ok"] is False

    def test_heartbeat_message(self):
        message = TaskHeartbeatMessage(id="run_123")

        assert message.type == "TASK_HEARTBEAT"
        assert message.version == "v1"
        assert message.id == "run_123"

    def test_index_tasks_complete_message(self):
        tasks = [
            {"id": "task1", "filePath": "/task1.py", "exportName": "task1"},
            {"id": "task2", "filePath": "/task2.py", "exportName": "task2"},
        ]
        message = IndexTasksCompleteMessage(tasks=tasks)

        assert message.type == "INDEX_TASKS_COMPLETE"
        assert message.version == "v1"
        assert len(message.tasks) == 2


class TestCoordinatorMessages:
    """Test coordinator → worker messages"""

    def test_execute_task_run_message(self):
        execution_data = {
            "task": {"id": "test-task", "filePath": "/task.py"},
            "run": {
                "id": "run_123",
                "payload": "{}",
                "payloadType": "application/json",
                "tags": [],
                "isTest": False,
            },
            "attempt": {
                "id": "attempt_123",
                "number": 1,
                "startedAt": "2024-01-01T00:00:00Z",
            },
        }
        message = ExecuteTaskRunMessage(execution=execution_data)

        assert message.type == "EXECUTE_TASK_RUN"
        assert message.version == "v1"

        # Test parsing execution
        execution = message.get_execution()
        assert isinstance(execution, TaskRunExecution)
        assert execution.task.id == "test-task"

    def test_cancel_message(self):
        message = CancelMessage()
        assert message.type == "CANCEL"
        assert message.version == "v1"

    def test_flush_message(self):
        message = FlushMessage()
        assert message.type == "FLUSH"
        assert message.version == "v1"


class TestResourceSchemas:
    """Test task resource schemas"""

    def test_task_resource_minimal(self):
        resource = TaskResource(
            id="test-task",
            filePath="/path/to/task.py",
            exportName="test-task",
        )
        assert resource.id == "test-task"
        assert resource.filePath == "/path/to/task.py"
        assert resource.exportName == "test-task"
        assert resource.description is None

    def test_task_resource_with_configs(self):
        resource = TaskResource(
            id="test-task",
            filePath="/task.py",
            exportName="test-task",
            queue=QueueConfig(name="critical", concurrencyLimit=5),
            retry=RetryConfig(maxAttempts=3, factor=2.0),
            maxDuration=300,
        )
        assert resource.queue.name == "critical"
        assert resource.queue.concurrencyLimit == 5
        assert resource.retry.maxAttempts == 3
        assert resource.maxDuration == 300


class TestMessageSerialization:
    """Test JSON serialization/deserialization of messages"""

    def test_worker_message_round_trip(self):
        """Test that messages can be serialized and deserialized"""
        message = TaskHeartbeatMessage(id="run_123")

        # Serialize to JSON
        json_str = message.model_dump_json()

        # Deserialize back
        data = json.loads(json_str)
        message2 = TaskHeartbeatMessage.model_validate(data)

        assert message2.type == message.type
        assert message2.id == message.id

    def test_coordinator_message_from_json(self):
        """Test parsing coordinator message from JSON string"""
        json_str = '{"type": "CANCEL", "version": "v1"}'
        data = json.loads(json_str)
        message = CancelMessage.model_validate(data)

        assert message.type == "CANCEL"
        assert message.version == "v1"

    def test_execution_result_serialization(self):
        """Test full execution result serialization"""
        result = TaskRunSuccessfulExecutionResult(
            id="run_123",
            output='{"data": "test"}',
            usage=TaskRunExecutionUsage(durationMs=1500),
        )

        # Serialize
        data = result.model_dump()

        # Verify structure
        assert data["ok"] is True
        assert data["id"] == "run_123"
        assert data["outputType"] == "application/json"
        assert data["usage"]["durationMs"] == 1500


class TestSchemaDefaults:
    """Test that schema defaults match TypeScript expectations"""

    def test_message_version_defaults(self):
        """All messages should default to version v1"""
        assert TaskHeartbeatMessage(id="test").version == "v1"
        assert CancelMessage().version == "v1"
        assert FlushMessage().version == "v1"

    def test_output_type_default(self):
        """Output type should default to application/json"""
        result = TaskRunSuccessfulExecutionResult(id="run_123")
        assert result.outputType == "application/json"

    def test_error_type_literals(self):
        """Error types should have correct literal values"""
        built_in = TaskRunBuiltInError(
            name="Error", message="msg", stackTrace=""
        )
        internal = TaskRunInternalError(code="INTERNAL_ERROR")
        string_err = TaskRunStringError(raw="error")

        assert built_in.type == "BUILT_IN_ERROR"
        assert internal.type == "INTERNAL_ERROR"
        assert string_err.type == "STRING_ERROR"


class TestOptionalFields:
    """Test optional field handling"""

    def test_task_run_execution_optional_fields(self):
        """Optional fields should not cause validation errors"""
        execution = TaskRunExecution(
            task=TaskInfo(id="t1", filePath="/t.py"),
            run=RunInfo(id="r1", payload="{}", payloadType="json"),
            attempt=AttemptInfo(id="a1", number=1, startedAt="2024-01-01"),
        )

        # Should serialize without errors even with None optional fields
        data = execution.model_dump()
        assert "organization" in data
        assert data["organization"] is None

    def test_task_resource_optional_configs(self):
        """Task resource should work without queue/retry configs"""
        resource = TaskResource(
            id="task1",
            filePath="/task.py",
            exportName="task1",
        )

        data = resource.model_dump()
        assert data["queue"] is None
        assert data["retry"] is None
        assert data["maxDuration"] is None
