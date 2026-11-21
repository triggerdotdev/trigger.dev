import type { CalendarProps } from "./Calendar";
import { LazyLoad, lazyWithRetry } from "./LazyLoad";
import { Spinner } from "./Spinner";

// react-day-picker only matters once a date popover opens, so the calendar loads on demand
// (preloaded when the trigger is hovered or focused) instead of with every filtered list page.
const loadCalendar = () => import("./Calendar");
const Calendar = lazyWithRetry(() =>
  loadCalendar().then((module) => ({ default: module.Calendar }))
);

export function preloadCalendar() {
  void loadCalendar();
}

export function LazyCalendar(props: CalendarProps) {
  return (
    <LazyLoad
      fallback={
        <div className="flex h-[21rem] w-[15.5rem] items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <Calendar {...props} />
    </LazyLoad>
  );
}
