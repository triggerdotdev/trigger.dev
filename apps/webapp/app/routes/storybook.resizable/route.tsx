import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";

export default function Story() {
  return (
    <div className="h-full">
      <ResizablePanelGroup>
        <ResizablePanel id={"1-left"} className="bg-sky-500" />
        <ResizableHandle id="1-split" />
        <ResizablePanel
          id={"1-right"}
          // min="100px"
          // max="250px"
          default="100px"
          className="bg-teal-500"
        />
      </ResizablePanelGroup>
    </div>
  );
}
