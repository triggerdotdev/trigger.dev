import { motion } from "framer-motion";
import { ComponentNames } from "../storybook/StoryKit";
import {
  draggableResizeHandleClassName,
  useDraggableResizable,
  type ResizeEdge,
} from "~/components/primitives/DraggableResizable";

const EDGES: ResizeEdge[] = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];

export default function Story() {
  const { style, dragHandleProps, resizeHandleProps } = useDraggableResizable({
    initial: { x: 120, y: 120, w: 360, h: 240 },
    minSize: { w: 200, h: 140 },
    maxSize: { w: 640, h: 480 },
  });

  return (
    <div className="h-full">
      <div className="px-4 pt-4">
        <ComponentNames names={["DraggableResizable.tsx"]} />
      </div>
      <div
        style={style}
        className="flex flex-col overflow-hidden rounded-md border border-grid-bright bg-background-bright shadow-lg"
      >
        <motion.div
          {...dragHandleProps}
          className="flex h-8 shrink-0 cursor-grab touch-none select-none items-center bg-background-dimmed px-3 text-xs text-text-dimmed active:cursor-grabbing"
        >
          Drag me
        </motion.div>
        <div className="flex flex-1 items-center justify-center text-sm text-text-dimmed">
          Resize from any edge or corner
        </div>
        {EDGES.map((edge) => (
          <motion.div
            key={edge}
            {...resizeHandleProps(edge)}
            className={draggableResizeHandleClassName(edge)}
          />
        ))}
      </div>
    </div>
  );
}
