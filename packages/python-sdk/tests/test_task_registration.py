"""Tests for task registration"""

import pytest
from trigger_sdk import task, Task, TASK_REGISTRY
from trigger_sdk.task import clear_registry


@pytest.fixture(autouse=True)
def reset_registry():
    """Clear registry before each test"""
    clear_registry()
    yield
    clear_registry()


def test_task_decorator_sync():
    """Test task decorator with sync function"""
    @task("test-sync")
    def my_task(payload):
        return {"result": payload["value"] * 2}

    assert isinstance(my_task, Task)
    assert my_task.id == "test-sync"
    assert "test-sync" in TASK_REGISTRY


def test_task_decorator_async():
    """Test task decorator with async function"""
    @task("test-async")
    async def my_task(payload):
        return {"result": payload["value"] * 2}

    assert isinstance(my_task, Task)
    assert my_task.id == "test-async"


@pytest.mark.asyncio
async def test_task_execution_async():
    """Test executing async task"""
    @task("test-exec-async")
    async def my_task(payload):
        return {"result": payload["value"] * 2}

    result = await my_task.execute({"value": 21})
    assert result == {"result": 42}


@pytest.mark.asyncio
async def test_task_execution_sync():
    """Test executing sync task"""
    @task("test-exec-sync")
    def my_task(payload):
        return {"result": payload["value"] * 2}

    result = await my_task.execute({"value": 21})
    assert result == {"result": 42}


def test_task_with_retry_config():
    """Test task with retry configuration"""
    @task("test-retry", retry={"maxAttempts": 5, "factor": 3.0})
    async def my_task(payload):
        return payload

    assert my_task.config.retry.maxAttempts == 5
    assert my_task.config.retry.factor == 3.0


def test_task_with_queue_config():
    """Test task with queue configuration"""
    @task("test-queue", queue={"name": "critical", "concurrencyLimit": 10})
    async def my_task(payload):
        return payload

    assert my_task.config.queue.name == "critical"
    assert my_task.config.queue.concurrencyLimit == 10


def test_duplicate_task_id_raises():
    """Test that duplicate task IDs raise an error"""
    @task("duplicate-id")
    async def task1(payload):
        return payload

    with pytest.raises(ValueError, match="already registered"):
        @task("duplicate-id")
        async def task2(payload):
            return payload


def test_get_task_metadata():
    """Test task metadata generation"""
    @task("test-metadata", max_duration=300)
    async def my_task(payload):
        return payload

    metadata = my_task.get_metadata()
    assert metadata.id == "test-metadata"
    assert metadata.exportName == "test-metadata"
    assert metadata.maxDuration == 300
