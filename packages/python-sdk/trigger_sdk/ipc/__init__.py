"""
IPC (Inter-Process Communication) layer for Python workers.

Provides transport-agnostic message communication between Python workers
and the Node.js coordinator.
"""

from trigger_sdk.ipc.base import IpcConnection
from trigger_sdk.ipc.stdio import StdioIpcConnection

__all__ = ["IpcConnection", "StdioIpcConnection"]
