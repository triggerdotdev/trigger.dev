export const normalizeEmail = (email: string): string => {
  const [localPart, domain] = email.split("@");
  const normalizedEmail = `${localPart}@${domain.toLowerCase()}`;
  return normalizedEmail;
};
