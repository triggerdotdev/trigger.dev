const compactFormatter = Intl.NumberFormat("en", { notation: "compact", compactDisplay: "short" });

export const formatNumberCompact = (num: number): string => {
  return compactFormatter.format(num);
};

const formatter = Intl.NumberFormat("en");

// Formatter for small decimal values that need more precision
const preciseFormatter = Intl.NumberFormat("en", {
  minimumSignificantDigits: 1,
  maximumSignificantDigits: 6,
});

export const formatNumber = (num: number): string => {
  // For very small numbers (between -1 and 1, exclusive), use precise formatting
  // to avoid rounding 0.000025 to 0
  if (num !== 0 && Math.abs(num) < 1) {
    return preciseFormatter.format(num);
  }
  return formatter.format(num);
};

const roundedCurrencyFormatter = Intl.NumberFormat("en-US", {
  style: "currency",
  currencyDisplay: "symbol",
  maximumFractionDigits: 0,
  currency: "USD",
});
const currencyFormatter = Intl.NumberFormat("en-US", {
  style: "currency",
  currencyDisplay: "symbol",
  currency: "USD",
});

export const formatCurrency = (num: number, rounded: boolean): string => {
  return rounded ? roundedCurrencyFormatter.format(num) : currencyFormatter.format(num);
};

const accurateCurrencyFormatter = Intl.NumberFormat("en-US", {
  style: "currency",
  currencyDisplay: "symbol",
  minimumFractionDigits: 8,
  maximumFractionDigits: 8,
  currency: "USD",
});

export function formatCurrencyAccurate(num: number): string {
  return accurateCurrencyFormatter.format(num);
}
