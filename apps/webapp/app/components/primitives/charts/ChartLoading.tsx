import { motion } from "framer-motion";
import { Button } from "../Buttons";
import { Paragraph } from "../Paragraph";
import { Spinner } from "../Spinner";
import { useDateRange } from "./DateRangeContext";
import { useMemo } from "react";
import { ClientOnly } from "remix-utils/client-only";

export function ChartBarLoading() {
  return (
    <div className="relative grid h-full place-items-center p-2 pt-0">
      <ChartBarLoadingBackground />
      <div className="absolute z-10 mb-16 flex items-center gap-2">
        <Spinner className="size-6" />
        <Paragraph variant="base/bright">Loading data…</Paragraph>
      </div>
    </div>
  );
}

export function ChartBarNoData() {
  const dateRange = useDateRange();

  return (
    <div className="relative grid h-full place-items-center p-2 pt-0">
      <ChartBarLoadingBackground />
      <div className="absolute z-10 mb-16 flex flex-col items-center gap-2">
        <Paragraph variant="small/bright">No data</Paragraph>
        <Paragraph variant="small" spacing>
          There's no data available for the filters you've set.
        </Paragraph>
        {dateRange && (
          <Button variant="secondary/small" onClick={dateRange.resetDateRange}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

export function ChartBarInvalid() {
  const dateRange = useDateRange();

  return (
    <div className="relative grid h-full place-items-center p-2 pt-0">
      <ChartBarLoadingBackground />
      <div className="absolute z-10 mb-16 flex flex-col items-center gap-2">
        <Paragraph variant="small/bright">Chart not applicable</Paragraph>
        <Paragraph variant="small" spacing>
          Your current filter settings don't apply to this chart's data type.
        </Paragraph>
        {dateRange && (
          <Button variant="secondary/small" onClick={dateRange.resetDateRange}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

export function ChartLineLoading() {
  return (
    <div className="relative mb-16 grid h-full place-items-center p-2 pt-0">
      <ChartLineLoadingBackground />
      <div className="absolute z-10 flex items-center gap-2">
        <Spinner className="size-6" />
        <Paragraph variant="base/bright">Loading data…</Paragraph>
      </div>
    </div>
  );
}

export function ChartLineNoData() {
  const dateRange = useDateRange();

  return (
    <div className="relative grid h-full place-items-center p-2 pt-0">
      <ChartLineLoadingBackground />
      <div className="absolute z-10 mb-16 flex flex-col items-center gap-2">
        <Paragraph variant="small/bright">No data</Paragraph>
        <Paragraph variant="small" spacing>
          There's no data available for the filters you've set.
        </Paragraph>
        {dateRange && (
          <Button variant="secondary/small" onClick={dateRange.resetDateRange}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

export function ChartLineInvalid() {
  const dateRange = useDateRange();

  return (
    <div className="relative grid h-full place-items-center p-2 pt-0">
      <ChartLineLoadingBackground />
      <div className="absolute z-10 mb-16 flex flex-col items-center gap-2">
        <Paragraph variant="small/bright">Chart not applicable</Paragraph>
        <Paragraph variant="small" spacing>
          Your current filter settings don't apply to this chart's data type.
        </Paragraph>
        {dateRange && (
          <Button variant="secondary/small" onClick={dateRange.resetDateRange}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

function ChartBarLoadingBackground() {
  return (
    <motion.div
      className="flex h-full w-full flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      <ClientOnly fallback={<div />}>
      {() => (<>
        <motion.div
        className="flex flex-1 items-end gap-1"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.1 }}
      >
        {Array.from({ length: 30 }).map((_, i) => {
          const height = Math.max(15, Math.floor(Math.random() * 100));
          return (
            <motion.div
              key={i}
              className="flex-1 rounded-sm bg-charcoal-750/50"
              style={{ height: `${height}%` }}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: `${height}%`, opacity: 1 }}
              transition={{
                type: "spring",
                stiffness: 120,
                damping: 14,
                mass: 1,
                delay: 0.1 + i * 0.02,
              }}
            />
          );
        })}
      </motion.div>
      <motion.div
        className="mt-2 flex flex-col justify-center gap-1"
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{
          type: "spring",
          stiffness: 100,
          damping: 15,
          delay: 0.2,
        }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <motion.div
            className="flex items-center gap-1"
            key={i}
            initial={{ x: -10, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{
              type: "spring",
              stiffness: 100,
              damping: 12,
              delay: 0.3 + i * 0.08,
            }}
          >
            <div className="h-5 w-2 rounded-sm bg-charcoal-750/50" />
            <div className="h-5 w-full rounded-sm bg-charcoal-750/50" />
          </motion.div>
        ))}
      </motion.div>
      </>)}
    </ClientOnly>
      
    </motion.div>
  );
}

function ChartLineLoadingBackground() {
  // Generate line points with configurable starting position and constraints
  const generateLinePoints = (startY: number, minY: number, maxY: number) => {
    const numPoints = 10;
    const points = [];
    let lastY = startY;

    for (let i = 0; i < numPoints; i++) {
      // Calculate x value that spreads points across the full width
      const x = i * (9 / (numPoints - 1));

      // Create less extreme variations that move smoothly
      const change = Math.random() * 6 - 3; // Range from -3 to +3
      const y = Math.max(minY, Math.min(maxY, lastY + change)); // Apply constraints

      points.push({ x, y });
      lastY = y;
    }

    return points;
  };

  // Generate points for both lines
  const points = useMemo(() => generateLinePoints(30, 10, 90), []);
  const secondPoints = useMemo(() => generateLinePoints(40, 30, 90), []);

  const generateSmoothPath = (points: Array<{ x: number; y: number }>) => {
    if (points.length < 2) return "";

    let path = `M0,${50 - points[0].y}`;

    // Use curve command for smooth lines
    for (let i = 0; i < points.length - 1; i++) {
      const x1 = points[i].x;
      const y1 = 50 - points[i].y;
      const x2 = points[i + 1].x;
      const y2 = 50 - points[i + 1].y;

      // Bezier control points (create smooth curve)
      const cx1 = (x1 + x2) / 2;
      const cy1 = y1;
      const cx2 = (x1 + x2) / 2;
      const cy2 = y2;

      path += ` C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}`;
    }

    return path;
  };

  const generateAreaPath = (points: Array<{ x: number; y: number }>) => {
    const curvePath = generateSmoothPath(points);
    const lastX = 9;
    return `${curvePath} L${lastX},50 L0,50 Z`;
  };

  // Component to render a line with area fill and animation
  const AnimatedLine = ({
    points,
    gradientId,
    delay = 0,
  }: {
    points: Array<{ x: number; y: number }>;
    gradientId: string;
    delay?: number;
  }) => (
    <>
      <motion.path
        d={generateAreaPath(points)}
        fill={`url(#${gradientId})`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, ease: "easeInOut", delay }}
      />
      <motion.path
        d={generateSmoothPath(points)}
        stroke="#212327"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.8 }}
        transition={{ duration: 1.5, ease: "easeInOut", delay }}
        vectorEffect="non-scaling-stroke"
      />
    </>
  );

  return (
    <motion.div
      className="flex h-full w-full flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      <div className="relative flex-1">
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 9 50"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#212327" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#212327" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="secondAreaGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#212327" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#212327" stopOpacity={0} />
            </linearGradient>
          </defs>

          <g>
            <AnimatedLine points={points} gradientId="areaGradient" />
            <AnimatedLine points={secondPoints} gradientId="secondAreaGradient" delay={0.2} />
          </g>
        </svg>
      </div>

      <motion.div
        className="mt-2 flex flex-col justify-center gap-1"
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{
          type: "spring",
          stiffness: 100,
          damping: 15,
          delay: 0.2,
        }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <motion.div
            className="flex items-center gap-1"
            key={i}
            initial={{ x: -10, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{
              type: "spring",
              stiffness: 100,
              damping: 12,
              delay: 0.3 + i * 0.08,
            }}
          >
            <div className="h-5 w-2 rounded-sm bg-charcoal-750/50" />
            <div className="h-5 w-full rounded-sm bg-charcoal-750/50" />
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
}
