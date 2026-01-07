import { motion } from "framer-motion";
import { useEffect, useState } from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "spline-viewer": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          url?: string;
          "loading-anim-type"?: string;
        },
        HTMLElement
      >;
    }
  }
}

export function TriggerRotatingLogo() {
  const [isSplineReady, setIsSplineReady] = useState(false);

  useEffect(() => {
    // Already registered from a previous render
    if (customElements.get("spline-viewer")) {
      setIsSplineReady(true);
      return;
    }

    const script = document.createElement("script");
    script.type = "module";
    script.src = "https://unpkg.com/@splinetool/viewer@1.12.29/build/spline-viewer.js";
    script.onload = () => setIsSplineReady(true);
    // On error, we simply don't show the decorative viewer - no action needed
    document.head.appendChild(script);
  }, []);

  if (!isSplineReady) {
    return null;
  }

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.5, duration: 2, ease: "easeOut" }}
    >
      <spline-viewer
        loading-anim-type="spinner-small-light"
        url="https://prod.spline.design/wRly8TZN-e0Twb8W/scene.splinecode"
        style={{ width: "100%", height: "100%" }}
      />
    </motion.div>
  );
}
