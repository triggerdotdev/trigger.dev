import React, { createContext, useState, useContext, type ReactNode } from "react";

type DateRangeContextType = {
  /** Start date as ISO string (YYYY-MM-DD) or custom format */
  startDate: string;
  /** End date as ISO string (YYYY-MM-DD) or custom format */
  endDate: string;
  setDateRange: (startDate: string, endDate: string) => void;
  resetDateRange: () => void;
};

// Formatters for displaying dates
const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const longDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * Format a Date object as a short date string (e.g., "Nov 1")
 */
export function formatChartDate(date: Date): string {
  return shortDateFormatter.format(date);
}

/**
 * Format a Date object as a long date string (e.g., "Nov 1, 2023")
 */
export function formatChartDateLong(date: Date): string {
  return longDateFormatter.format(date);
}

/**
 * Convert a Date to ISO date string (YYYY-MM-DD)
 */
export function toISODateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Parse an ISO date string to a Date object
 */
export function parseISODateString(isoString: string): Date {
  return new Date(isoString + "T00:00:00");
}

/**
 * Format an ISO date string for display (e.g., "2023-11-01" -> "Nov 1")
 */
export function formatISODate(isoString: string): string {
  const date = parseISODateString(isoString);
  return formatChartDate(date);
}

/**
 * Format an ISO date string for display with year (e.g., "2023-11-01" -> "Nov 1, 2023")
 */
export function formatISODateLong(isoString: string): string {
  const date = parseISODateString(isoString);
  return formatChartDateLong(date);
}

const DateRangeContext = createContext<DateRangeContextType | null>(null);

export function DateRangeProvider({
  children,
  defaultStartDate,
  defaultEndDate,
}: {
  children: ReactNode;
  defaultStartDate: Date;
  defaultEndDate: Date;
}) {
  // Store dates as ISO strings for consistent data matching
  const defaultStartISO = toISODateString(defaultStartDate);
  const defaultEndISO = toISODateString(defaultEndDate);

  const [startDate, setStartDate] = useState<string>(defaultStartISO);
  const [endDate, setEndDate] = useState<string>(defaultEndISO);

  const setDateRange = (start: string, end: string) => {
    setStartDate(start);
    setEndDate(end);
  };

  const resetDateRange = () => {
    setStartDate(defaultStartISO);
    setEndDate(defaultEndISO);
  };

  return (
    <DateRangeContext.Provider
      value={{
        startDate,
        endDate,
        setDateRange,
        resetDateRange,
      }}
    >
      {children}
    </DateRangeContext.Provider>
  );
}

export function useDateRange(): DateRangeContextType | null {
  const context = useContext(DateRangeContext);
  if (!context) {
    return null;
  }
  return context;
}
