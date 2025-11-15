"""
IPC (Inter-Process Communication) layer for Python workers.

Provides gRPC-based message communication between Python workers
and the Node.js coordinator.
"""

from trigger_sdk.ipc.base import IpcConnection
from trigger_sdk.ipc.grpc import GrpcIpcConnection

__all__ = ["IpcConnection", "GrpcIpcConnection"]
