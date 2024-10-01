export const boolFromEnv = (env: string, defaultValue: boolean): boolean => {
  const value = process.env[env];

  if (!value) {
    return defaultValue;
  }

  return ["1", "true"].includes(value);
};

export const numFromEnv = (env: string, defaultValue: number): number => {
  const value = process.env[env];

  if (!value) {
    return defaultValue;
  }

  return parseInt(value, 10);
};
