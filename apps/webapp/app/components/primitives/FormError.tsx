import type { z } from "zod";

//todo use a new Input Field Error component
export function FormError({
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
        <p key={index}>{error.message}</p>
      ))}
    </div>
  );
}
