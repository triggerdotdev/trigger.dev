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
          [
            [scope.current, { width: "30%", left: "35%" }, { duration: 1, ease: "easeIn" }],
            [scope.current, { width: 0, left: "100%" }, { duration: 1, ease: "easeOut" }],
          ],
          { repeat: Infinity, repeatType: "reverse" }
        );
      };
      enterAnimation();
    } else {
      const exitAnimation = async () => {
        await animate(scope.current, { opacity: 0 });
        safeToRemove();
      };

      exitAnimation();
    }
  }, [isPresent, isLoading]);

  return (
    <AnimatePresence>
      {isLoading && (
        <div
          ref={scope}
          className="width-0 absolute left-0 top-0 h-full bg-gradient-to-r from-transparent from-5% via-blue-500 to-transparent to-95%"
        />
      )}
    </AnimatePresence>
  );
}
