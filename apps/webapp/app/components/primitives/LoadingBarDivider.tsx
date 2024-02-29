import { AnimatePresence, motion } from "framer-motion";

type LoadingBarDividerProps = {
  isLoading: boolean;
};

export function LoadingBarDivider({ isLoading }: LoadingBarDividerProps) {
  return (
    <div className="h-px w-full bg-grid-bright">
      <AnimatePresence>
        {isLoading && (
          <motion.div
            className="absolute left-0 top-0 h-px w-0 bg-blue-500"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "100%", opacity: 1 }}
            transition={{ duration: 3, yoyo: Infinity, ease: "easeInOut" }}
            exit={{ opacity: 0 }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
