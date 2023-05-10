import type { z } from "zod";
import { Paragraph } from "./Paragraph";

export function FormError({ children }: { children: React.ReactNode }) {
  return (
    <Paragraph variant="small" className="text-red-500">
      {children}
    </Paragraph>
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
    <div className="col-span-full mt-2 text-sm text-red-600">
      {relevantErrors.map((error, index) => (
        <FormError key={index}>{error.message}</FormError>
      ))}
    </div>
  );
}
