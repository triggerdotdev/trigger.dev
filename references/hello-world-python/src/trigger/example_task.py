"""
Example Python task for testing build system
"""

import asyncio
from trigger_sdk import task, logger

@task("hello-task-v2")
async def hello_task(payload):
    """A simple test task"""
    return {"message": "Hello from Python!", "payload": payload}


@task("data-processor", max_duration=60)
def process_data(payload):
    """Sync task example"""
    data = payload.get("data", "")
    return {"result": data.upper()}


@task("long-running-task", max_duration=300)
async def long_running_task(payload):
    """A long-running task with multiple logging statementsx"""
    logger.info("Starting long-running task", step="initialization")

    # Simulate some initial processing
    await asyncio.sleep(2)
    logger.debug("Completed initialization phase")

    # Process data in stages
    stages = ["data-collection", "data-processing", "data-transformation", "data-validation"]

    for i, stage in enumerate(stages, 1):
        logger.info(f"Processing stage {i}/{len(stages)}: {stage}", stage=stage, progress=f"{i}/{len(stages)}")
        await asyncio.sleep(3)
        logger.debug(f"Completed {stage}", stage=stage)

    # Simulate some final work
    logger.info("Finalizing results", step="finalization")
    await asyncio.sleep(2)

    logger.info("Task completed successfully", total_duration="~17s")

    return {
        "status": "completed",
        "stages_processed": len(stages),
        "payload": payload
    }
