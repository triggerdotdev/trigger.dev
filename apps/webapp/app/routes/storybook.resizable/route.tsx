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
          default="100px"
          min="100px"
          max="600px"
          className="bg-teal-500"
          isStaticAtRest
        />
      </ResizablePanelGroup>
    </div>
  );
}
