"""Test Python task for worker testing"""

# Import SDK (assumes it's installed via pip)
from trigger_sdk import task, logger


@task("test-python-task")
async def test_task(payload):
    """Simple test task"""
    logger.info(f"Test task received payload: {payload}")

    name = payload.get("name", "World")

    return {
        "message": f"Hello {name} from Python!",
        "payload": payload,
    }


@task("test-python-error", retry={"maxAttempts": 3})
async def error_task(payload):
    """Task that raises an error"""
    logger.error("This task will fail")
    raise RuntimeError("Intentional error for testing")


@task("test-python-sync")
def sync_task(payload):
    """Synchronous task"""
    return {"sync": True, "payload": payload}
