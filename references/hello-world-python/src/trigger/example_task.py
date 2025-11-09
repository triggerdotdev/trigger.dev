"""
Example Python task for testing build system
"""

from trigger_sdk import task

@task("hello-task")
async def hello_task(payload):
    """A simple test task"""
    return {"message": "Hello from Python!", "payload": payload}


@task("data-processor", max_duration=60)
def process_data(payload):
    """Sync task example"""
    data = payload.get("data", "")
    return {"result": data.upper()}
