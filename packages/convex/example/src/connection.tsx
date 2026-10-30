import { Component, type ReactNode } from "react";
import { useAction, useConvexConnectionState, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import App, { getSessionToken } from "./App";
import { RealtimeJobPanel } from "./RealtimeJobPanel";

export function ConnectedApp() {
  const sessionToken = getSessionToken();
  const board = useQuery(api.jobs.board, { sessionToken });
  const processImages = useAction(api.jobs.process);
  const connection = useConvexConnectionState();
  return (
    <App
      board={board}
      processImages={processImages}
      connected={connection.isWebSocketConnected}
      JobView={RealtimeJobPanel}
    />
  );
}

export class ConnectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <App preview connectionError /> : this.props.children;
  }
}
