export const sanitizeEnvVars = (obj: Record<string, string | undefined>) => {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) =>
      typeof value === "string" ? !!value.trim() : !!value
    )
  );
};
