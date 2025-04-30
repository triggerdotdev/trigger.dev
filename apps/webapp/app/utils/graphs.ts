type Options<R> = {
  startDate: Date;
  endDate: Date;
  window?: "MINUTE" | "HOUR" | "DAY";
  data: { date: Date; value?: R }[];
};

export function createTimeSeriesData<R>({ startDate, endDate, window = "DAY", data }: Options<R>) {
  const outputData: Array<{ date: Date; value?: R }> = [];
  const periodLength = periodLengthMs(window);
  const periodCount = Math.round((endDate.getTime() - startDate.getTime()) / periodLength);

  for (let i = 0; i < periodCount; i++) {
    const periodStart = new Date(startDate);
    periodStart.setTime(periodStart.getTime() + i * periodLength);
    const periodEnd = new Date(startDate);
    periodEnd.setTime(periodEnd.getTime() + (i + 1) * periodLength);

    const foundData = data.find((d) => {
      const time = d.date.getTime();
      const inRange = time >= periodStart.getTime() && time < periodEnd.getTime();
      return inRange;
    });
    if (!foundData) {
      outputData.push({
        date: periodStart,
      });
    } else {
      outputData.push({
        date: periodStart,
        value: foundData.value,
      });
    }
  }

  return outputData;
}

function periodLengthMs(window: "MINUTE" | "HOUR" | "DAY") {
  switch (window) {
    case "MINUTE":
      return 60_000;
    case "HOUR":
      return 3_600_000;
    case "DAY":
      return 86_400_000;
  }
}
