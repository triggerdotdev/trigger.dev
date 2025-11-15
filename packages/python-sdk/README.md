# Trigger.dev Python SDK

Python SDK for Trigger.dev v3

## Installation

```bash
pip install trigger-sdk
```

## Quick Start

```python
from trigger_sdk import task

@task("my-task-id")
async def my_task(payload):
    return {"result": "success"}
```

## Features

- Task registration with decorator API
- Support for both sync and async functions
- Retry configuration
- Queue configuration
- Task duration limits
- Type-safe with Pydantic models

## Requirements

- Python >= 3.10
- pydantic >= 2.0.0

## Development

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run type checking
mypy trigger_sdk
```
