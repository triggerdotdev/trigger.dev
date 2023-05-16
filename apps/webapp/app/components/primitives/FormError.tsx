import type { z } from "zod";
import { Paragraph } from "./Paragraph";
import { NamedIcon } from "./NamedIcon";
import { motion } from "framer-motion";

export function FormError({
  children,
  id,
}: {
  children: React.ReactNode;
  id?: string;
}) {
  return (
    children && (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="flex items-center gap-0.5"
      >
        <NamedIcon name="error" className="h-4 w-4 shrink-0 justify-start" />
        <Paragraph id={id} variant="extra-small" className="text-rose-500">
          {children}
        </Paragraph>
      </motion.div>
    )
  );
}

export function ZodFormErrors({
  errors,
  path,
}: {
  errors: z.ZodIssue[];
  path: string[];
}) {
  if (errors.length === 0) {
    return null;
  }

  const relevantErrors = errors.filter((error) => {
    return error.path.join(".") === path.join(".");
  });

  if (relevantErrors.length === 0) {
    return null;
  }

  return (
    <div className="col-span-full mt-1 text-sm text-rose-600">
      {relevantErrors.map((error, index) => (
        <FormError key={index}>{error.message}</FormError>
      ))}
    </div>
  );
}
