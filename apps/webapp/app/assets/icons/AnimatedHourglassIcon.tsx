import { useAnimate } from "framer-motion";
import { HourglassIcon } from "lucide-react";
import { useEffect, useRef } from "react";

export function AnimatedHourglassIcon({
  className,
  delay,
}: {
  className?: string;
  delay?: number;
}) {
  const [scope, animate] = useAnimate();
  const initialDelay = useRef(delay);

  useEffect(() => {
    const controls = animate(
      [
        [scope.current, { rotate: 0 }, { duration: 0.7 }],
        [scope.current, { rotate: 180 }, { duration: 0.3 }],
        [scope.current, { rotate: 180 }, { duration: 0.7 }],
        [scope.current, { rotate: 360 }, { duration: 0.3 }],
      ],
      { repeat: Infinity, delay: initialDelay.current }
    );

    return () => controls.stop();
  }, [animate, scope]);

  return <HourglassIcon ref={scope} className={className} />;
}
