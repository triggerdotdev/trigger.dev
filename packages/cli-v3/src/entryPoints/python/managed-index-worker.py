#!/usr/bin/env python3
"""
Python Index Worker

Discovers and indexes Python tasks by importing task files.

Flow:
1. Read BuildManifest from environment or file
2. Import all Python task files
3. Collect tasks from TASK_REGISTRY
4. Send INDEX_TASKS_COMPLETE message with task metadata
"""

import sys
import json
import os
import asyncio
import importlib.util
import traceback
from pathlib import Path
from typing import Dict, List, Any

# Import SDK (assumes it's installed via pip)
from trigger_sdk.task import TASK_REGISTRY
from trigger_sdk.ipc import StdioIpcConnection
from trigger_sdk.schemas import IndexTasksCompleteMessage, TaskResource
from trigger_sdk.logger import logger


def load_manifest() -> Dict[str, Any]:
    """Load build manifest from file or environment"""
    manifest_path = os.getenv("TRIGGER_MANIFEST_PATH", "./build-manifest.json")

    try:
        with open(manifest_path, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        logger.error(f"Manifest not found at {manifest_path}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid manifest JSON: {e}")
        sys.exit(1)


def import_task_file(file_path: str) -> bool:
    """
    Import a Python task file.

    Returns True if successful, False otherwise.
    """
    try:
        # Resolve absolute path
        abs_path = Path(file_path).resolve()

        if not abs_path.exists():
            logger.error(f"Task file not found: {file_path}")
            return False

        # Create module name from file path
        module_name = abs_path.stem.replace(".", "_")

        # Import module
        spec = importlib.util.spec_from_file_location(module_name, abs_path)
        if spec is None or spec.loader is None:
            logger.error(f"Failed to create module spec for {file_path}")
            return False

        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)

        logger.debug(f"Successfully imported {file_path}")
        return True

    except Exception as e:
        logger.error(f"Failed to import {file_path}: {e}", exception=traceback.format_exc())
        return False


def collect_task_metadata() -> List[Dict[str, Any]]:
    """Collect metadata from all registered tasks"""
    tasks = []

    for task_id, task in TASK_REGISTRY.items():
        try:
            # Get task metadata
            task_meta = task.get_metadata()

            # Convert to TaskResource schema
            # Note: Convert retry/queue to dicts to handle schema differences
            task_resource = TaskResource(
                id=task_meta.id,
                filePath=task_meta.filePath,
                exportName=task_meta.exportName,
                retry=task_meta.retry.model_dump() if task_meta.retry else None,
                queue=task_meta.queue.model_dump() if task_meta.queue else None,
                maxDuration=task_meta.maxDuration,
            )

            tasks.append(task_resource.model_dump())
            logger.debug(f"Collected task: {task_id}")
        except Exception as e:
            logger.error(f"Failed to get metadata for task {task_id}: {e}")

    return tasks


async def main():
    """Main indexing workflow"""
    logger.info("Python index worker starting")

    # Load manifest
    manifest = load_manifest()
    logger.info(f"Loaded manifest with {len(manifest.get('tasks', []))} task files")

    # Import all task files
    task_files = manifest.get("tasks", [])
    success_count = 0

    for task_file in task_files:
        file_path = task_file.get("filePath") or task_file.get("entry")
        if file_path and import_task_file(file_path):
            success_count += 1

    logger.info(f"Imported {success_count}/{len(task_files)} task files")

    # Collect task metadata
    tasks = collect_task_metadata()
    logger.info(f"Found {len(tasks)} tasks")

    # Send INDEX_TASKS_COMPLETE message
    ipc = StdioIpcConnection()
    message = IndexTasksCompleteMessage(tasks=tasks)
    await ipc.send(message)

    logger.info("Indexing complete")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Index worker interrupted")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Index worker failed: {e}", exception=traceback.format_exc())
        sys.exit(1)
