"""
Another task to verify multiple file discovery
"""

from trigger_sdk import task

@task("async-task", retry={"maxAttempts": 3})
async def async_task(payload):
    """Async task example"""
    return {"status": "completed", "input": payload}
