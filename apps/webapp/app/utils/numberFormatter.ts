export const formatter = Intl.NumberFormat("en", { notation: "compact", compactDisplay: "short" });

export const formatNumberCompact = (num: number): string => {
  return formatter.format(num);
};
