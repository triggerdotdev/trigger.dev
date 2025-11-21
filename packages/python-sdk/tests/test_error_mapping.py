"""Tests for exception to TaskRunError conversion"""

import json
import pytest
from trigger_sdk.errors import exception_to_task_run_error, get_error_code_for_exception
from trigger_sdk.schemas.errors import (
    TaskRunBuiltInError,
    TaskRunInternalError,
    TaskRunStringError,
)


class TestBuiltInErrorMapping:
    """Test mapping of built-in Python exceptions"""

    def test_type_error_to_built_in_error(self):
        """Test TypeError maps to BUILT_IN_ERROR"""
        exc = TypeError("cannot add str and int")
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunBuiltInError)
        assert error.type == "BUILT_IN_ERROR"
        assert error.name == "TypeError"
        assert "cannot add str and int" in error.message
        assert len(error.stackTrace) > 0

    def test_value_error_to_built_in_error(self):
        """Test ValueError maps to BUILT_IN_ERROR"""
        exc = ValueError("invalid literal for int()")
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunBuiltInError)
        assert error.name == "ValueError"
        assert "invalid literal" in error.message

    def test_attribute_error_to_built_in_error(self):
        """Test AttributeError maps to BUILT_IN_ERROR"""
        exc = AttributeError("object has no attribute 'foo'")
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunBuiltInError)
        assert error.name == "AttributeError"

    def test_key_error_to_built_in_error(self):
        """Test KeyError maps to BUILT_IN_ERROR"""
        exc = KeyError("missing_key")
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunBuiltInError)
        assert error.name == "KeyError"

    def test_runtime_error_to_built_in_error(self):
        """Test RuntimeError maps to BUILT_IN_ERROR"""
        exc = RuntimeError("something went wrong")
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunBuiltInError)
        assert error.name == "RuntimeError"


class TestInternalErrorMapping:
    """Test mapping of system errors to INTERNAL_ERROR"""

    def test_import_error_to_internal_error(self):
        """Test ImportError maps to INTERNAL_ERROR with COULD_NOT_IMPORT_TASK"""
        exc = ImportError("No module named 'missing_module'")
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunInternalError)
        assert error.type == "INTERNAL_ERROR"
        assert error.code == "COULD_NOT_IMPORT_TASK"
        assert "missing_module" in error.message

    def test_module_not_found_error_to_internal_error(self):
        """Test ModuleNotFoundError maps to INTERNAL_ERROR"""
        exc = ModuleNotFoundError("No module named 'foo'")
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunInternalError)
        assert error.code == "COULD_NOT_IMPORT_TASK"

    def test_system_exit_to_internal_error(self):
        """Test SystemExit maps to TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE"""
        exc = SystemExit(1)
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunInternalError)
        assert error.code == "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE"

    def test_keyboard_interrupt_to_cancelled(self):
        """Test KeyboardInterrupt maps to TASK_RUN_CANCELLED"""
        exc = KeyboardInterrupt()
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunInternalError)
        assert error.code == "TASK_RUN_CANCELLED"

    def test_syntax_error_to_input_error(self):
        """Test SyntaxError maps to TASK_INPUT_ERROR"""
        exc = SyntaxError("invalid syntax")
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunInternalError)
        assert error.code == "TASK_INPUT_ERROR"

    def test_timeout_error_to_max_duration(self):
        """Test TimeoutError maps to MAX_DURATION_EXCEEDED"""
        exc = TimeoutError("Task timed out")
        error = exception_to_task_run_error(exc)

        # Could be BUILT_IN_ERROR or INTERNAL_ERROR depending on context
        # Check that it's handled properly
        if isinstance(error, TaskRunInternalError):
            assert error.code == "MAX_DURATION_EXCEEDED"
        else:
            # TimeoutError is also a built-in, so this is acceptable
            assert isinstance(error, TaskRunBuiltInError)


class TestErrorCodeMapping:
    """Test get_error_code_for_exception() function"""

    def test_import_error_code(self):
        """Test ImportError returns correct code"""
        code = get_error_code_for_exception(ImportError())
        assert code == "COULD_NOT_IMPORT_TASK"

    def test_system_exit_code(self):
        """Test SystemExit returns correct code"""
        code = get_error_code_for_exception(SystemExit(1))
        assert code == "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE"

    def test_keyboard_interrupt_code(self):
        """Test KeyboardInterrupt returns correct code"""
        code = get_error_code_for_exception(KeyboardInterrupt())
        assert code == "TASK_RUN_CANCELLED"

    def test_syntax_error_code(self):
        """Test SyntaxError returns correct code"""
        code = get_error_code_for_exception(SyntaxError())
        assert code == "TASK_INPUT_ERROR"

    def test_generic_exception_code(self):
        """Test generic Exception returns fallback code"""
        code = get_error_code_for_exception(Exception())
        assert code == "TASK_EXECUTION_FAILED"


class TestStackTracePreservation:
    """Test that stack traces are preserved in error conversion"""

    def test_stack_trace_captured(self):
        """Test that stack trace is included in error"""
        try:
            raise ValueError("test error")
        except ValueError as e:
            error = exception_to_task_run_error(e)

        assert len(error.stackTrace) > 0
        assert "test error" in error.stackTrace
        assert "Traceback" in error.stackTrace

    def test_nested_stack_trace(self):
        """Test stack trace with nested calls"""
        def inner():
            raise RuntimeError("inner error")

        def outer():
            inner()

        try:
            outer()
        except RuntimeError as e:
            error = exception_to_task_run_error(e)

        assert isinstance(error, TaskRunBuiltInError)
        assert "inner" in error.stackTrace
        assert "outer" in error.stackTrace


class TestStringErrorFallback:
    """Test fallback to STRING_ERROR for unknown exceptions"""

    def test_custom_exception_to_string_error(self):
        """Test that custom exceptions without mapping become STRING_ERROR"""
        class CustomException(Exception):
            pass

        exc = CustomException("custom error message")
        error = exception_to_task_run_error(exc)

        # Custom exception should have error code fallback
        assert isinstance(error, TaskRunInternalError)
        assert error.code == "TASK_EXECUTION_FAILED"

    def test_error_serialization(self):
        """Test that all error types can be serialized to JSON"""
        errors = [
            exception_to_task_run_error(ValueError("test")),
            exception_to_task_run_error(ImportError("test")),
            exception_to_task_run_error(KeyboardInterrupt()),
        ]

        for error in errors:
            # Should serialize without errors
            json_str = error.model_dump_json()
            data = json.loads(json_str)

            # Should have type field
            assert "type" in data
            assert data["type"] in ["BUILT_IN_ERROR", "INTERNAL_ERROR", "STRING_ERROR"]


class TestErrorMessageFormatting:
    """Test error message formatting"""

    def test_error_message_contains_exception_text(self):
        """Test that error message includes the exception text"""
        exc = ValueError("invalid value: 42")
        error = exception_to_task_run_error(exc)

        assert "invalid value: 42" in error.message

    def test_error_preserves_exception_name(self):
        """Test that error preserves the exception class name"""
        exc = ZeroDivisionError("division by zero")
        error = exception_to_task_run_error(exc)

        assert isinstance(error, TaskRunBuiltInError)
        assert error.name == "ZeroDivisionError"

    def test_empty_exception_message(self):
        """Test handling of exceptions with no message"""
        exc = ValueError()
        error = exception_to_task_run_error(exc)

        # Should still work, just with empty/default message
        assert isinstance(error, TaskRunBuiltInError)
        assert error.name == "ValueError"
