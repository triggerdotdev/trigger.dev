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

  interface Window {
    __splineLoader?: Promise<void>;
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

    // Another mount already started loading - share the same promise
    if (window.__splineLoader) {
      window.__splineLoader.then(() => setIsSplineReady(true)).catch(() => setIsSplineReady(false));
      return;
    }

    // First mount: create script and shared loader promise
    const script = document.createElement("script");
    script.type = "module";
    // Version pinned; SRI hash omitted as unpkg doesn't guarantee hash stability across deploys
    script.src = "https://unpkg.com/@splinetool/viewer@1.12.29/build/spline-viewer.js";

    window.__splineLoader = new Promise<void>((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject();
    });

    window.__splineLoader.then(() => setIsSplineReady(true)).catch(() => setIsSplineReady(false));

    document.head.appendChild(script);

    // Intentionally no cleanup: once the custom element is registered globally,
    // removing the script would break re-mounts while providing no benefit
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
