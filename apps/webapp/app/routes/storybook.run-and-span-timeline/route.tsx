import {
  RunTimeline,
  RunTimelineEvent,
  SpanTimeline,
  SpanTimelineProps,
  TimelineSpanRun,
} from "~/components/run/RunTimeline";
import { Header2 } from "~/components/primitives/Headers";

const spanTimelines = [
  {
    startTime: new Date(),
    duration: 1000 * 1_000_000,
    inProgress: false,
    isError: false,
  },
  {
    startTime: new Date(),
    duration: 1000 * 1_000_000,
    inProgress: true,
    isError: false,
  },
  {
    startTime: new Date(),
    duration: 1000 * 1_000_000,
    inProgress: false,
    isError: true,
  },
  {
    startTime: new Date(),
    duration: 1000 * 1_000_000,
    inProgress: false,
    isError: false,
    events: [
      {
        name: "Dequeued",
        offset: 0,
        timestamp: new Date(Date.now() - 5000),
        duration: 4000,
        markerVariant: "start-cap",
        lineVariant: "light",
      },
      {
        name: "Launched",
        offset: 0,
        timestamp: new Date(Date.now() - 1000),
        duration: 1000,
        markerVariant: "dot-hollow",
        lineVariant: "light",
      },
      {
        name: "Imported task file",
        offset: 0,
        timestamp: new Date(Date.now() - 1000),
        duration: 1000,
        markerVariant: "dot-hollow",
        lineVariant: "light",
      },
    ],
  },
  {
    startTime: new Date(),
    duration: 1000 * 1_000_000,
    inProgress: false,
    isError: false,
    events: [
      {
        name: "Dequeued",
        offset: 0,
        timestamp: new Date(Date.now() - 5000),
        duration: 4000,
        markerVariant: "start-cap",
        lineVariant: "light",
      },
      {
        name: "Launched",
        offset: 0,
        timestamp: new Date(Date.now() - 1000),
        duration: 1000,
        markerVariant: "dot-hollow",
        lineVariant: "light",
      },
    ],
  },
  {
    startTime: new Date(),
    duration: 1000 * 1_000_000,
    inProgress: false,
    isError: false,
    events: [
      {
        name: "Dequeued",
        offset: 0,
        timestamp: new Date(Date.now() - 5000),
        duration: 4000,
        markerVariant: "start-cap",
        lineVariant: "light",
      },
      {
        name: "Forked",
        offset: 0,
        timestamp: new Date(Date.now() - 1000),
        duration: 1000,
        markerVariant: "dot-hollow",
        lineVariant: "light",
      },
    ],
  },
  {
    startTime: new Date(),
    duration: 1000 * 1_000_000,
    inProgress: false,
    isError: false,
    events: [
      {
        name: "Dequeued",
        offset: 0,
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000),
        duration: 4000,
        markerVariant: "start-cap",
        lineVariant: "light",
      },
      {
        name: "Forked",
        offset: 0,
        timestamp: new Date(Date.now() - 1000),
        duration: 1000,
        markerVariant: "dot-hollow",
        lineVariant: "light",
      },
    ],
  },
] satisfies SpanTimelineProps[];

const runTimelines = [
  {
    createdAt: new Date(),
    updatedAt: new Date(),
    isFinished: false,
    isError: false,
  },
  {
    createdAt: new Date(Date.now() - 1000 * 60),
    updatedAt: new Date(),
    startedAt: new Date(Date.now() - 1000 * 30),
    isFinished: false,
    isError: false,
  },
  {
    createdAt: new Date(Date.now() - 1000 * 60),
    updatedAt: new Date(),
    startedAt: new Date(Date.now() - 1000 * 30),
    executedAt: new Date(Date.now() - 1000 * 20),
    isFinished: false,
    isError: false,
  },
  {
    createdAt: new Date(Date.now() - 1000 * 60),
    updatedAt: new Date(),
    startedAt: new Date(Date.now() - 1000 * 30),
    executedAt: new Date(Date.now() - 1000 * 20),
    completedAt: new Date(Date.now() - 1000 * 15),
    isFinished: true,
    isError: false,
  },
  {
    createdAt: new Date(Date.now() - 1000 * 60),
    updatedAt: new Date(),
    startedAt: new Date(Date.now() - 1000 * 30),
    executedAt: new Date(Date.now() - 1000 * 20),
    completedAt: new Date(Date.now() - 1000 * 15),
    isFinished: true,
    isError: true,
  },
  {
    createdAt: new Date(Date.now() - 1000 * 60),
    updatedAt: new Date(),
    startedAt: new Date(Date.now() - 1000 * 30),
    completedAt: new Date(Date.now() - 1000 * 15),
    isFinished: true,
    isError: false,
  },
  {
    createdAt: new Date(Date.now() - 1000 * 60),
    updatedAt: new Date(),
    delayUntil: new Date(Date.now() + 1000 * 60),
    ttl: "1m",
    isFinished: false,
    isError: false,
  },
] satisfies TimelineSpanRun[];

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-8 p-4">
      <Header2>Span Timeline</Header2>
      {spanTimelines.map((props, index) => (
        <SpanTimeline key={index} {...props} />
      ))}
      <Header2>Run Timeline</Header2>
      {runTimelines.map((run, index) => (
        <RunTimeline key={index} run={run} />
      ))}
    </div>
  );
}
