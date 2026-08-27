import { Paragraph } from "./Paragraph";
import { motion } from "framer-motion";
import { cn } from "~/utils/cn";
import { ErrorIcon } from "~/assets/icons/ErrorIcon";

export function FormError({
  children,
  id,
  className,
}: {
  children: React.ReactNode;
  id?: string;
  className?: string;
}) {
  return children ? (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className={cn("flex items-start gap-0.5", className)}
    >
      <ErrorIcon className="h-4 w-4 shrink-0 justify-start text-rose-500" />
      <Paragraph id={id} variant="extra-small" className="text-rose-500">
        {children}
      </Paragraph>
    </motion.div>
  ) : null;
}
