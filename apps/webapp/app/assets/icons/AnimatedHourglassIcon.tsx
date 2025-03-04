import { useAnimate } from "framer-motion";
import { HourglassIcon } from "lucide-react";
import { useEffect } from "react";

export function AnimatedHourglassIcon({
  className,
  delay,
}: {
  className?: string;
  delay?: number;
}) {
  const [scope, animate] = useAnimate();

  useEffect(() => {
    animate(
      [
        [scope.current, { rotate: 0 }, { duration: 0.7 }],
        [scope.current, { rotate: 180 }, { duration: 0.3 }],
        [scope.current, { rotate: 180 }, { duration: 0.7 }],
        [scope.current, { rotate: 360 }, { duration: 0.3 }],
      ],
      { repeat: Infinity, delay }
    );
  }, []);

  return <HourglassIcon ref={scope} className={className} />;
}
