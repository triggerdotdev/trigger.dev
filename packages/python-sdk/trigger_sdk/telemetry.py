"""OpenTelemetry integration (minimal implementation)"""

from typing import Dict, Optional
import os


class TraceContext:
    """
    Minimal OpenTelemetry trace context.

    Full OpenTelemetry integration can be added later.
    """

    def __init__(
        self,
        trace_id: Optional[str] = None,
        span_id: Optional[str] = None,
        trace_flags: Optional[str] = None,
    ):
        self.trace_id = trace_id
        self.span_id = span_id
        self.trace_flags = trace_flags

    @classmethod
    def from_traceparent(cls, traceparent: str) -> "TraceContext":
        """
        Parse W3C traceparent header.

        Format: 00-{trace_id}-{span_id}-{flags}
        """
        parts = traceparent.split("-")
        if len(parts) != 4:
            raise ValueError(f"Invalid traceparent format: {traceparent}")

        return cls(
            trace_id=parts[1],
            span_id=parts[2],
            trace_flags=parts[3],
        )

    @classmethod
    def from_env(cls) -> Optional["TraceContext"]:
        """Get trace context from TRACEPARENT environment variable"""
        traceparent = os.getenv("TRACEPARENT")
        if not traceparent:
            return None

        return cls.from_traceparent(traceparent)

    def to_traceparent(self) -> str:
        """Convert to W3C traceparent header"""
        return f"00-{self.trace_id}-{self.span_id}-{self.trace_flags}"

    def inject_env(self) -> Dict[str, str]:
        """Get environment variables for propagation"""
        if not self.trace_id:
            return {}

        return {
            "TRACEPARENT": self.to_traceparent(),
        }


def get_trace_context() -> Optional[TraceContext]:
    """Get current trace context from environment"""
    return TraceContext.from_env()
