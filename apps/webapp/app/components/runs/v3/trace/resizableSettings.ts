export const resizableSettings = {
  parent: {
    autosaveId: "panel-run-parent-v3",
    handleId: "parent-handle",
    main: {
      id: "run",
      min: "100px" as const,
    },
    inspector: {
      id: "inspector",
      default: "500px" as const,
      min: "250px" as const,
    },
  },
  tree: {
    autosaveId: "panel-run-tree",
    handleId: "tree-handle",
    tree: {
      id: "tree",
      default: "50%" as const,
      min: "50px" as const,
    },
    timeline: {
      id: "timeline",
      default: "50%" as const,
      min: "50px" as const,
    },
  },
};
