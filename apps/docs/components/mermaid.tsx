"use client";

import { useEffect, useId, useState } from "react";
import { useTheme } from "next-themes";

// Rendered on the client so it also works inside tabs and accordions.
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState("");
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        fontFamily: "inherit",
        theme: resolvedTheme === "light" ? "default" : "dark",
      });
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, chart);
        if (!cancelled) setSvg(svg);
      } catch (e) {
        console.error("mermaid render failed", e);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (!svg) return <pre className="text-xs opacity-60">{chart}</pre>;
  return (
    <div
      className="my-4 flex justify-center [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
