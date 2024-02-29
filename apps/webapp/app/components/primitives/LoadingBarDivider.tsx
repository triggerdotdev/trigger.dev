import { AnimatePresence, useAnimate, usePresence } from "framer-motion";
import { useEffect } from "react";

type LoadingBarDividerProps = {
  isLoading: boolean;
};

export function LoadingBarDivider({ isLoading }: LoadingBarDividerProps) {
  return (
    <div className="relative h-px w-full bg-grid-bright">
      <AnimationDivider isLoading={isLoading} />
    </div>
  );
}

export function AnimationDivider({ isLoading }: LoadingBarDividerProps) {
  const [scope, animate] = useAnimate();
  const [isPresent, safeToRemove] = usePresence();

  useEffect(() => {
    if (isPresent) {
      const enterAnimation = async () => {
        await animate(
          scope.current,
          { width: "50%", left: "25%" },
          { duration: 1, ease: "easeIn" }
        );
        await animate(scope.current, { width: 0, left: "100%" }, { duration: 1, ease: "easeOut" });
      };
      enterAnimation();
    } else {
      const exitAnimation = async () => {
        await animate(scope.current, { opacity: 0 });
        safeToRemove();
      };

      exitAnimation();
    }
  }, [isPresent]);

  return (
    <AnimatePresence>
      {isLoading && (
        <div ref={scope} className="width-0 absolute left-0 top-0 h-full bg-blue-500" />
      )}
    </AnimatePresence>
  );
}

// initial={{ width: 0, left: 0, translateX: 0 }}
//           animate={{
//             width: ["0%", "50%", "0%", "50%", "0%"],
//             left: ["0%", "50%", "0%"],
//             translateX: ["0%", "-50%", "0%"],
//           }}
//           transition={{ duration: 6, repeat: 1, repeatType: "reverse", ease: "easeInOut" }}
//           exit={{ opacity: 0 }}
