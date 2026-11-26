"use client";
import { useEffect } from "react";
import { modelContext, webMcpTools } from "@/lib/webmcp";

/** Registers the docs tools with WebMCP where the browser has it (lib/webmcp.ts). */
export function WebMcp() {
  useEffect(() => {
    const mc = modelContext();
    if (!mc) return;
    const controller = new AbortController();
    const handles = webMcpTools.map((tool) => {
      try {
        return mc.registerTool(tool, { signal: controller.signal });
      } catch (err) {
        console.warn(`[docs] WebMCP: couldn't register ${tool.name}`, err);
      }
    });
    return () => {
      controller.abort();
      // Early previews returned a handle with unregister() instead of taking a signal.
      for (const h of handles)
        if (h && typeof (h as { unregister?: unknown }).unregister === "function")
          (h as { unregister: () => void }).unregister();
    };
  }, []);
  return null;
}
