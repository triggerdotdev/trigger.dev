import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import { ConnectedApp, ConnectionBoundary } from "./connection";
import "./styles.css";

const url = import.meta.env.VITE_CONVEX_URL?.trim();
let client: ConvexReactClient | undefined;
let invalidUrl = false;
if (url) {
  try {
    client = new ConvexReactClient(url);
  } catch {
    invalidUrl = true;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {client ? (
      <ConnectionBoundary>
        <ConvexProvider client={client}>
          <ConnectedApp />
        </ConvexProvider>
      </ConnectionBoundary>
    ) : (
      <App preview connectionError={invalidUrl} />
    )}
  </StrictMode>
);
