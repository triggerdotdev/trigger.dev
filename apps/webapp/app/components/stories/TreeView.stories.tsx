import type { Meta, StoryObj } from "@storybook/react";
import { useTreeData } from "react-stately";
import { withDesign } from "storybook-addon-designs";
import { TreeView } from "../primitives/TreeView";

const meta: Meta = {
  title: "Primitives/TreeView",
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof TreeViewsSet>;

export const TreeViews: Story = {
  render: () => <TreeViewsSet />,
};

const data = [
  {
    title: "Policies",
    items: [
      {
        title: "Registration",
        items: [
          {
            title: "Registration A",
            items: [],
          },
          {
            title: "Registration B",
            items: [],
          },
          {
            title: "Registration C",
            items: [],
          },
          {
            title: "Registration D",
            items: [],
          },
        ],
      },
      {
        title: "Authentication",
        items: [
          {
            title: "Authentication A",
            items: [],
          },
          {
            title: "Authentication B",
            items: [],
          },
        ],
      },
    ],
  },
  {
    title: "Other",
    items: [{ title: "Other A", items: [] }],
  },
  {
    title: "Single Item",
    items: [],
  },
];

function TreeViewsSet() {
  const tree = useTreeData({
    initialItems: data,
    getKey: (item) => item.title,
    getChildren: (item) => item.items,
  });

  return (
    <div className="grid grid-cols-2">
      <div className="flex flex-col items-start gap-y-4 p-4">
        <TreeView tree={tree} />
      </div>
    </div>
  );
}
