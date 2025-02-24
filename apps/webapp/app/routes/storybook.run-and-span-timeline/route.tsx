import {
  RunTimeline,
  RunTimelineEvent,
  SpanTimeline,
  SpanTimelineProps,
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
        adminOnly: false,
      },
      {
        name: "Launched",
        offset: 0,
        timestamp: new Date(Date.now() - 1000),
        duration: 1000,
        adminOnly: false,
      },
      {
        name: "Imported task file",
        offset: 0,
        timestamp: new Date(Date.now() - 1000),
        duration: 1000,
        adminOnly: true,
      },
    ],
  },
  {
    startTime: new Date(),
    duration: 1000 * 1_000_000,
    inProgress: false,
    isError: false,
    showAdminOnlyEvents: true,
    events: [
      {
        name: "Dequeued",
        offset: 0,
        timestamp: new Date(Date.now() - 5000),
        duration: 4000,
        adminOnly: false,
      },
      {
        name: "Forked",
        offset: 0,
        timestamp: new Date(Date.now() - 1000),
        duration: 1000,
        adminOnly: true,
      },
    ],
  },
  {
    startTime: new Date(),
    duration: 1000 * 1_000_000,
    inProgress: false,
    isError: false,
    showAdminOnlyEvents: true,
    events: [
      {
        name: "Dequeued",
        offset: 0,
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000),
        duration: 4000,
        adminOnly: false,
      },
      {
        name: "Forked",
        offset: 0,
        timestamp: new Date(Date.now() - 1000),
        duration: 1000,
        adminOnly: true,
      },
    ],
  },
] satisfies SpanTimelineProps[];

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-4 p-4">
      <Header2>Span Timeline</Header2>
      {spanTimelines.map((props, index) => (
        <SpanTimeline key={index} {...props} />
      ))}
    </div>
  );
}
