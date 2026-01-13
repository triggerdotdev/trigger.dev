import React, { createContext, useState, useContext, type ReactNode } from "react";

type DateRangeContextType = {
  startDate: string;
  endDate: string;
  setDateRange: (startDate: string, endDate: string) => void;
  resetDateRange: () => void;
};

const chartDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function formatChartDate(date: Date): string {
  return chartDateFormatter.format(date);
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
  // Store the formatted string dates that match chart data format
  const formattedStartDate = formatChartDate(defaultStartDate);
  const formattedEndDate = formatChartDate(defaultEndDate);

  const [startDate, setStartDate] = useState<string>(formattedStartDate);
  const [endDate, setEndDate] = useState<string>(formattedEndDate);

  const setDateRange = (start: string, end: string) => {
    setStartDate(start);
    setEndDate(end);
  };

  const resetDateRange = () => {
    setStartDate(formattedStartDate);
    setEndDate(formattedEndDate);
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
