"""Tests for stdio IPC implementation"""

import json
import asyncio
import pytest
from io import StringIO
from unittest.mock import patch, AsyncMock

from trigger_sdk.ipc import StdioIpcConnection
from trigger_sdk.schemas import (
    TaskHeartbeatMessage,
    ExecuteTaskRunMessage,
    CancelMessage,
)


class TestStdioIpcSend:
    """Test sending messages via stdio"""

    @pytest.mark.asyncio
    async def test_send_writes_json_to_stdout(self):
        """Test that send() writes line-delimited JSON to stdout"""
        ipc = StdioIpcConnection()
        message = TaskHeartbeatMessage(id="run_123")

        with patch("sys.stdout", new=StringIO()) as mock_stdout:
            await ipc.send(message)

            output = mock_stdout.getvalue()
            lines = output.strip().split("\n")

            assert len(lines) == 1
            data = json.loads(lines[0])
            assert data["type"] == "TASK_HEARTBEAT"
            assert data["id"] == "run_123"

    @pytest.mark.asyncio
    async def test_send_completed_helper(self):
        """Test send_completed() convenience method"""
        ipc = StdioIpcConnection()

        with patch("sys.stdout", new=StringIO()) as mock_stdout:
            await ipc.send_completed(
                id="run_123",
                output={"result": "success"},
                usage={"durationMs": 1500},
            )

            output = mock_stdout.getvalue()
            data = json.loads(output.strip())

            assert data["type"] == "TASK_RUN_COMPLETED"
            assert data["completion"]["ok"] is True
            assert data["completion"]["id"] == "run_123"
            assert "result" in json.loads(data["completion"]["output"])
            assert data["completion"]["usage"]["durationMs"] == 1500

    @pytest.mark.asyncio
    async def test_send_failed_helper(self):
        """Test send_failed() convenience method"""
        ipc = StdioIpcConnection()
        error = ValueError("Test error")

        with patch("sys.stdout", new=StringIO()) as mock_stdout:
            await ipc.send_failed(
                id="run_123",
                error=error,
                usage={"durationMs": 500},
            )

            output = mock_stdout.getvalue()
            data = json.loads(output.strip())

            assert data["type"] == "TASK_RUN_FAILED_TO_RUN"
            assert data["completion"]["ok"] is False
            assert data["completion"]["id"] == "run_123"
            assert "Test error" in str(data["completion"]["error"])

    @pytest.mark.asyncio
    async def test_send_heartbeat_helper(self):
        """Test send_heartbeat() convenience method"""
        ipc = StdioIpcConnection()

        with patch("sys.stdout", new=StringIO()) as mock_stdout:
            await ipc.send_heartbeat("run_123")

            output = mock_stdout.getvalue()
            data = json.loads(output.strip())

            assert data["type"] == "TASK_HEARTBEAT"
            assert data["id"] == "run_123"


class TestStdioIpcReceive:
    """Test receiving messages via stdio"""

    @pytest.mark.asyncio
    async def test_receive_execute_message(self):
        """Test receiving EXECUTE_TASK_RUN message"""
        ipc = StdioIpcConnection()
        received_messages = []

        async def handler(message):
            received_messages.append(message)

        ipc.on("EXECUTE_TASK_RUN", handler)

        # Create test message
        test_message = {
            "type": "EXECUTE_TASK_RUN",
            "version": "v1",
            "execution": {
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
            },
        }

        # Simulate stdin
        stdin_data = json.dumps(test_message) + "\n"
        with patch("sys.stdin", StringIO(stdin_data)):
            # Start listening (will read one message then hit EOF)
            await ipc.start_listening()

        assert len(received_messages) == 1
        assert isinstance(received_messages[0], ExecuteTaskRunMessage)
        assert received_messages[0].type == "EXECUTE_TASK_RUN"

    @pytest.mark.asyncio
    async def test_receive_cancel_message(self):
        """Test receiving CANCEL message"""
        ipc = StdioIpcConnection()
        received_messages = []

        def handler(message):
            received_messages.append(message)

        ipc.on("CANCEL", handler)

        stdin_data = '{"type": "CANCEL", "version": "v1"}\n'
        with patch("sys.stdin", StringIO(stdin_data)):
            await ipc.start_listening()

        assert len(received_messages) == 1
        assert isinstance(received_messages[0], CancelMessage)

    @pytest.mark.asyncio
    async def test_malformed_json_logged_not_crash(self):
        """Test that malformed JSON is logged to stderr and doesn't crash"""
        ipc = StdioIpcConnection()
        received_messages = []

        ipc.on("TEST", lambda msg: received_messages.append(msg))

        # Invalid JSON
        stdin_data = '{invalid json}\n'

        with patch("sys.stdin", StringIO(stdin_data)):
            with patch("sys.stderr", new=StringIO()) as mock_stderr:
                await ipc.start_listening()

                stderr_output = mock_stderr.getvalue()
                assert "Invalid JSON" in stderr_output or "JSONDecodeError" in stderr_output

        # Should not have crashed, should have no messages
        assert len(received_messages) == 0

    @pytest.mark.asyncio
    async def test_missing_type_field_logged(self):
        """Test that messages without 'type' field are logged"""
        ipc = StdioIpcConnection()

        stdin_data = '{"version": "v1"}\n'  # Missing type field

        with patch("sys.stdin", StringIO(stdin_data)):
            with patch("sys.stderr", new=StringIO()) as mock_stderr:
                await ipc.start_listening()

                stderr_output = mock_stderr.getvalue()
                assert "missing 'type'" in stderr_output.lower()

    @pytest.mark.asyncio
    async def test_unknown_message_type_logged(self):
        """Test that unknown message types are logged"""
        ipc = StdioIpcConnection()

        stdin_data = '{"type": "UNKNOWN_MESSAGE", "version": "v1"}\n'

        with patch("sys.stdin", StringIO(stdin_data)):
            with patch("sys.stderr", new=StringIO()) as mock_stderr:
                # Will fail validation, should be logged
                await ipc.start_listening()

                stderr_output = mock_stderr.getvalue()
                # Should have validation error or no handler message
                assert len(stderr_output) > 0


class TestStdioIpcHandlers:
    """Test message handler registration and dispatch"""

    @pytest.mark.asyncio
    async def test_handler_registration(self):
        """Test registering multiple handlers"""
        ipc = StdioIpcConnection()

        handler1_called = []
        handler2_called = []

        ipc.on("CANCEL", lambda msg: handler1_called.append(msg))
        ipc.on("FLUSH", lambda msg: handler2_called.append(msg))

        stdin_data = '{"type": "CANCEL", "version": "v1"}\n{"type": "FLUSH", "version": "v1"}\n'

        with patch("sys.stdin", StringIO(stdin_data)):
            await ipc.start_listening()

        assert len(handler1_called) == 1
        assert len(handler2_called) == 1

    @pytest.mark.asyncio
    async def test_async_handler_support(self):
        """Test that async handlers are awaited"""
        ipc = StdioIpcConnection()
        received = []

        async def async_handler(message):
            await asyncio.sleep(0.01)  # Simulate async work
            received.append(message)

        ipc.on("CANCEL", async_handler)

        stdin_data = '{"type": "CANCEL", "version": "v1"}\n'
        with patch("sys.stdin", StringIO(stdin_data)):
            await ipc.start_listening()

        assert len(received) == 1

    @pytest.mark.asyncio
    async def test_handler_exception_logged_not_crash(self):
        """Test that handler exceptions are caught and logged"""
        ipc = StdioIpcConnection()

        def failing_handler(message):
            raise RuntimeError("Handler failed")

        ipc.on("CANCEL", failing_handler)

        stdin_data = '{"type": "CANCEL", "version": "v1"}\n'

        with patch("sys.stdin", StringIO(stdin_data)):
            with patch("sys.stderr", new=StringIO()) as mock_stderr:
                # Should not raise, should log error
                await ipc.start_listening()

                stderr_output = mock_stderr.getvalue()
                assert "Handler error" in stderr_output or "Handler failed" in stderr_output


class TestStdioIpcLifecycle:
    """Test IPC connection lifecycle"""

    def test_initial_state(self):
        """Test IPC starts in stopped state"""
        ipc = StdioIpcConnection()
        assert ipc._running is False

    @pytest.mark.asyncio
    async def test_stop_method(self):
        """Test stop() method sets running to False"""
        ipc = StdioIpcConnection()

        # Mock stdin to avoid pytest capture issues
        with patch("sys.stdin", StringIO("")):
            # Start listening in background
            listen_task = asyncio.create_task(ipc.start_listening())

            # Give it time to start
            await asyncio.sleep(0.01)

            # Stop it
            ipc.stop()

            # Should finish quickly
            await asyncio.wait_for(listen_task, timeout=1.0)

        assert ipc._running is False


class TestStdioIpcThreadSafety:
    """Test thread-safety of message sending"""

    @pytest.mark.asyncio
    async def test_concurrent_sends_not_interleaved(self):
        """Test that concurrent sends don't interleave JSON"""
        ipc = StdioIpcConnection()

        async def send_message(msg_id):
            message = TaskHeartbeatMessage(id=f"run_{msg_id}")
            await ipc.send(message)

        with patch("sys.stdout", new=StringIO()) as mock_stdout:
            # Send 10 messages concurrently
            await asyncio.gather(*[send_message(i) for i in range(10)])

            output = mock_stdout.getvalue()
            lines = [line for line in output.split("\n") if line.strip()]

            # Should have 10 valid JSON lines
            assert len(lines) == 10

            # Each line should be valid JSON
            for line in lines:
                data = json.loads(line)
                assert data["type"] == "TASK_HEARTBEAT"
                assert "run_" in data["id"]
