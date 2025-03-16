import {
  DocumentIcon,
  FolderIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/20/solid";
import { useRef, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { Tree, TreeView, flattenTree, useTree } from "~/components/primitives/TreeView/TreeView";
import { cn } from "~/utils/cn";

const words = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipisicing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "et",
  "dolore",
  "magna",
  "aliqua",
  "enim",
  "ad",
  "minim",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
  "ullamco",
  "laboris",
  "nisi",
  "aliquip",
  "ex",
  "ea",
  "commodo",
  "consequat",
  "duis",
  "aute",
  "irure",
  "reprehenderit",
  "voluptate",
  "velit",
  "esse",
  "cillum",
  "eu",
  "fugiat",
  "nulla",
  "pariatur",
  "excepteur",
  "sint",
  "occaecat",
  "cupidatat",
  "non",
  "proident",
  "sunt",
  "culpa",
  "qui",
  "officia",
  "deserunt",
  "mollit",
  "anim",
  "id",
  "est",
  "laborum",
];

function generateTree(): Tree<{ title: string }> {
  const number = words.length;
  const rawRows = new Array(number).fill("").map((elem, idx) => {
    return {
      id: words[idx],
      data: { title: `${idx + 1}. ${words[idx]}` },
    };
  }) as Tree<{ title: string }>[];

  const rows: Tree<{ title: string }>[] = [];
  for (let i = 0; i < rawRows.length - 2; i += 3) {
    const row = rawRows[i];
    rows.push({
      ...row,
      children: [rawRows[i + 1], rawRows[i + 2]],
    });
  }

  return {
    id: "root",
    data: { title: "root" },
    children: rows,
  };
}

const data = generateTree();
const tree = flattenTree(data);

export default function Story() {
  const [selectedId, setSelectedId] = useState<string>("");
  const [collapsedIds, setCollapsedIds] = useState<string[]>([]);

  return (
    <div className="flex gap-12">
      <div className="flex flex-col items-start justify-start gap-4">
        <div className="flex items-center gap-2 p-2">
          <Input
            placeholder="Selected"
            value={selectedId}
            onChange={(v) => setSelectedId(v.target.value)}
          />
          <Input
            placeholder="Collapsed"
            value={collapsedIds.join(",")}
            onChange={(e) => {
              const val = e.target.value;
              const ids = val.split(",").map((v) => v.trim());
              setCollapsedIds(ids);
            }}
          />
        </div>

        <TreeViewParent selectedId={selectedId} collapsedIds={collapsedIds} />
      </div>
    </div>
  );
}

function TreeViewParent({
  selectedId,
  collapsedIds,
}: {
  selectedId?: string;
  collapsedIds?: string[];
}) {
  const [filterText, setFilterText] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  const {
    nodes,
    selected,
    getTreeProps,
    getNodeProps,
    toggleNodeSelection,
    toggleExpandNode,
    selectNode,
    selectFirstVisibleNode,
    selectLastVisibleNode,
    scrollToNode,
    virtualizer,
  } = useTree({
    tree,
    selectedId,
    collapsedIds,
    onSelectedIdChanged: (id) => {
      console.log("onSelectedIdChanged", id);
    },
    estimatedRowHeight: () => 32,
    parentRef,
    filter: {
      value: filterText,
      fn: (text, node) => {
        if (text === "") return true;
        if (node.data.title.toLowerCase().includes(text.toLowerCase())) {
          return true;
        }
        return false;
      },
    },
  });

  return (
    <div className="flex w-72 flex-col items-start gap-y-4 p-4">
      <div className="flex items-center gap-2">
        <Button variant="secondary/small" onClick={() => selectFirstVisibleNode()}>
          Select first
        </Button>
        <Button variant="secondary/small" onClick={() => selectLastVisibleNode()}>
          Select last
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search log"
          variant="tertiary"
          icon={MagnifyingGlassIcon}
          fullWidth={true}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>
      <TreeView
        parentRef={parentRef}
        virtualizer={virtualizer}
        autoFocus
        tree={tree}
        nodes={nodes}
        getNodeProps={getNodeProps}
        getTreeProps={getTreeProps}
        parentClassName="h-96 bg-charcoal-900"
        renderNode={({ node, state, index, virtualizer, virtualItem }) => (
          <div
            style={{
              paddingLeft: `${node.level * 1}rem`,
            }}
            className={cn(
              "flex cursor-pointer items-center gap-2 py-1 hover:bg-blue-500/10",
              state.selected && "bg-blue-500/20 hover:bg-blue-500/30"
            )}
            onClick={() => {
              toggleNodeSelection(node.id);
            }}
          >
            <div
              className="h-4 w-4"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpandNode(node.id);
                selectNode(node.id, true);
              }}
              onKeyDown={(e) => {
                console.log(e.key);
              }}
            >
              {node.hasChildren ? (
                state.expanded ? (
                  <FolderOpenIcon className="h-4 w-4 text-blue-500" />
                ) : (
                  <FolderIcon className="h-4 w-4 text-blue-500/50" />
                )
              ) : (
                <DocumentIcon className="h-4 w-4" />
              )}
            </div>
            <div>{node.data.title}</div>
          </div>
        )}
      />
    </div>
  );
}
