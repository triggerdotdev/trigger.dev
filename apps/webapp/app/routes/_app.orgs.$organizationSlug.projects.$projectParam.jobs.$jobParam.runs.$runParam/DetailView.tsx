import { Event, Task } from "~/presenters/RunPresenter.server";
import { RunPanel, RunPanelHeader } from "./RunCard";

type DetailProps =
  | {
      type: "task";
      task: Task;
    }
  | {
      type: "event";
      event: Event;
    };

export function Detail(props: DetailProps) {
  switch (props.type) {
    case "task":
      return <TaskDetail {...props.task} />;
    case "event":
      return <EventDetail {...props.event} />;
  }

  return <></>;
}

export function TaskDetail({ name, status, delayUntil }: Task) {
  return (
    <RunPanel selected={false}>
      {/* //todo what icon to use here?  */}
      {/* <RunPanelHeader icon={undefined} title={name} accessory={status === "WAITING" && delayUntil ? <button} /> */}
    </RunPanel>
  );
}

export function EventDetail({}: Event) {
  return (
    <RunPanel selected={false}>
      <RunPanelHeader icon={undefined} title={""} />
    </RunPanel>
  );
}
