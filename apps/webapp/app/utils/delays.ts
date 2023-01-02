export const calculateDurationInMs = (options: {
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
}) => {
  return (
    (options?.seconds ?? 0) * 1000 +
    (options?.minutes ?? 0) * 60 * 1000 +
    (options?.hours ?? 0) * 60 * 60 * 1000 +
    (options?.days ?? 0) * 24 * 60 * 60 * 1000
  );
};
