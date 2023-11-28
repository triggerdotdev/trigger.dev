export const formatter = Intl.NumberFormat("en", { notation: "compact" });

export const separator = (num: number): string => {
  return num.toLocaleString("en-US");
};
