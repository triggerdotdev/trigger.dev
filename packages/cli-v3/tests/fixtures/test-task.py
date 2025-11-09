"""
Simple test task for gRPC testing
"""
from trigger_sdk import task

@task(id="hello-grpc")
async def hello_task(payload):
    """Test task that returns a greeting"""
    message = payload.get("message", "World")
    return {"greeting": f"Hello {message} from Python via gRPC!"}
