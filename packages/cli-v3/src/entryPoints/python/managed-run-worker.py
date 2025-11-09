#!/usr/bin/env python3
"""
Python Run Worker

Executes a single Python task.

Flow:
1. Connect to coordinator via gRPC
2. Receive EXECUTE_TASK_RUN message
3. Set up execution context (trace context, env vars, etc.)
4. Import task file and get task from registry
5. Execute task with payload
6. Send TASK_RUN_COMPLETED or TASK_RUN_FAILED_TO_RUN message
7. Handle heartbeat and cancellation
"""

import sys
import json
import os
import asyncio
import importlib.util
import traceback
import signal
from pathlib import Path
from typing import Optional

# Import SDK (assumes it's installed via pip)
from trigger_sdk.task import TASK_REGISTRY, Task
from trigger_sdk.ipc import GrpcIpcConnection
from trigger_sdk.context import TaskContext, set_current_context, clear_current_context
from trigger_sdk.logger import logger
from trigger_sdk.schemas import ExecuteTaskRunMessage


# Global state
ipc: Optional[GrpcIpcConnection] = None
current_task: Optional[asyncio.Task] = None
cancelled = False


def signal_handler(signum, frame):
    """Handle termination signals"""
    global cancelled
    cancelled = True

    if current_task and not current_task.done():
        logger.debug(f"Received signal {signum}, cancelling task")
        current_task.cancel()
    else:
        logger.debug(f"Received signal {signum}, shutting down")


def import_task_file(file_path: str) -> bool:
    """Import a Python task file"""
    try:
        abs_path = Path(file_path).resolve()

        if not abs_path.exists():
            logger.error(f"Task file not found: {file_path}")
            return False

        module_name = abs_path.stem.replace(".", "_")
        spec = importlib.util.spec_from_file_location(module_name, abs_path)

        if spec is None or spec.loader is None:
            logger.error(f"Failed to create module spec for {file_path}")
            return False

        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)

        return True

    except Exception as e:
        logger.error(f"Failed to import {file_path}: {e}", exception=traceback.format_exc())
        return False


async def heartbeat_loop(run_id: str):
    """Send periodic heartbeat messages"""
    global ipc, cancelled

    while not cancelled:
        await asyncio.sleep(5)  # Heartbeat every 5 seconds
        if ipc and not cancelled:
            try:
                await ipc.send_heartbeat(id=run_id)
            except Exception as e:
                logger.error(f"Failed to send heartbeat: {e}")


async def execute_task_run(message: ExecuteTaskRunMessage):
    """Execute a task run from the execution message"""
    global ipc, current_task, cancelled

    # Parse execution payload using the helper method
    execution = message.get_execution()

    task_id = execution.task.id
    task_file = execution.task.filePath
    run_id = execution.run.id
    payload_str = execution.run.payload

    # Parse payload from JSON string to Python object
    try:
        payload = json.loads(payload_str) if isinstance(payload_str, str) else payload_str
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse payload JSON: {e}")
        raise ValueError(f"Invalid payload JSON: {e}")

    logger.debug(f"Executing task {task_id} from {task_file}")

    # Track start time for usage metrics
    import time
    start_time = time.time()

    try:
        # Import task file if not already imported
        if task_id not in TASK_REGISTRY:
            if not import_task_file(task_file):
                raise RuntimeError(f"Failed to import task file: {task_file}")

        # Get task from registry
        if task_id not in TASK_REGISTRY:
            raise RuntimeError(f"Task {task_id} not found in registry after import")

        task = TASK_REGISTRY[task_id]

        # Set up execution context
        context = TaskContext(
            task=execution.task,
            run=execution.run,
            attempt=execution.attempt,
            batch=execution.batch,
            environment=execution.environment or {},
        )
        set_current_context(context)

        logger.debug(f"Starting task execution (attempt {context.attempt.number})")

        # Start heartbeat with run_id parameter
        heartbeat_task = asyncio.create_task(heartbeat_loop(run_id))

        # Execute task
        try:
            current_task = asyncio.create_task(task.execute(payload))
            result = await current_task

            # Calculate duration
            duration_ms = int((time.time() - start_time) * 1000)

            logger.debug("Task completed successfully")
            await ipc.send_completed(
                id=run_id,
                output=result,
                usage={"durationMs": duration_ms}
            )

            # Wait for message to flush before exiting
            await ipc.flush()
            ipc.stop()

        finally:
            # Stop heartbeat
            cancelled = True
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass

    except asyncio.CancelledError:
        duration_ms = int((time.time() - start_time) * 1000)
        logger.warn("Task execution cancelled")
        await ipc.send_failed(
            id=run_id,
            error=Exception("Task cancelled"),
            usage={"durationMs": duration_ms}
        )

        # Wait for message to flush before exiting
        await ipc.flush()
        ipc.stop()

    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        logger.error(f"Task execution failed: {e}", exception=traceback.format_exc())
        await ipc.send_failed(
            id=run_id,
            error=e,
            usage={"durationMs": duration_ms}
        )

        # Wait for message to flush before exiting
        await ipc.flush()
        ipc.stop()

    finally:
        clear_current_context()
        current_task = None


async def handle_cancel(message):
    """Handle cancellation message"""
    global current_task
    logger.debug("Received CANCEL message")
    signal_handler(signal.SIGTERM, None)


async def main():
    """Main run worker loop"""
    global ipc, cancelled

    logger.debug("Python run worker starting")

    # Set up signal handlers
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    # Create gRPC IPC connection
    ipc = GrpcIpcConnection()

    # Configure logger to use gRPC
    logger.set_ipc_connection(ipc)

    # Register message handlers
    ipc.on("EXECUTE_TASK_RUN", execute_task_run)
    ipc.on("CANCEL", handle_cancel)

    # Start listening for messages
    try:
        await ipc.start_listening()
    except asyncio.CancelledError:
        logger.debug("Run worker cancelled")
    except Exception as e:
        logger.error(f"Run worker failed: {e}", exception=traceback.format_exc())
        sys.exit(1)

    logger.debug("Run worker stopped")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.debug("Run worker interrupted")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Run worker failed: {e}", exception=traceback.format_exc())
        sys.exit(1)
