"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Edge,
  MarkerType,
  NodeTypes,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { Globe, Speech, NotepadText, BellDot, Send } from "lucide-react";

import "@xyflow/react/dist/style.css";
import InputNode, { isInputNode, InputNodeData } from "./InputNode";
import ActionNode, { ActionNodeData } from "./ActionNode";
import ReviewNode, { isReviewNode, ReviewNodeData } from "./ReviewNode";
import type { scrape } from "@/trigger/scrapeSite";
import type { summarizeArticle } from "@/trigger/summarizeArticle";
import type { convertTextToSpeech } from "@/trigger/convertTextToSpeech";
import type { reviewSummary } from "@/trigger/reviewSummary";
import type { publishSummary } from "@/trigger/publishSummary";
import type { sendSlackNotification } from "@/trigger/sendSlackNotification";
import { useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";

type WorkflowNode = InputNodeData | ActionNodeData | ReviewNodeData;

const initialNodes: WorkflowNode[] = [
  {
    id: "1",
    type: "input_url",
    position: { x: 0, y: 150 },
    data: {},
  },
  {
    id: "2",
    type: "action",
    position: { x: 370, y: 0 },
    data: {
      label: "Scrape site",
      icon: Globe,
      trigger: {
        taskIdentifier: "scrape-site" satisfies (typeof scrape)["id"],
      },
    },
  },
  {
    id: "3",
    type: "action",
    position: { x: 370, y: 150 },
    data: {
      label: "Generate summary",
      icon: NotepadText,
      trigger: {
        taskIdentifier: "summarize-article" satisfies (typeof summarizeArticle)["id"],
      },
    },
  },
  {
    id: "4",
    type: "action",
    position: { x: 370, y: 310 },
    data: {
      label: "Convert to speech",
      icon: Speech,
      trigger: {
        taskIdentifier: "convert-text-to-speech" satisfies (typeof convertTextToSpeech)["id"],
      },
    },
  },
  {
    id: "5",
    type: "review",
    position: { x: 620, y: 115 },
    data: {
      trigger: {
        taskIdentifier: "review-summary" satisfies (typeof reviewSummary)["id"],
      },
    },
  },
  {
    id: "6",
    type: "action",
    position: { x: 880, y: 110 },
    data: {
      label: "Publish result",
      icon: Send,
      isTerminalAction: true,
      trigger: {
        taskIdentifier: "publish-summary" satisfies (typeof publishSummary)["id"],
      },
    },
  },
  {
    id: "7",
    type: "action",
    position: { x: 880, y: 190 },
    data: {
      label: "Slack Notification",
      icon: BellDot,
      isTerminalAction: true,
      trigger: {
        taskIdentifier: "send-slack-notification" satisfies (typeof sendSlackNotification)["id"],
      },
    },
  },
];

const initialEdges: Edge[] = [
  {
    id: "1->2",
    source: "1",
    target: "2",
    markerEnd: { type: MarkerType.Arrow, width: 20, height: 20 },
  },
  {
    id: "2->3",
    source: "2",
    target: "3",
    markerEnd: { type: MarkerType.Arrow, width: 20, height: 20 },
  },
  {
    id: "3->4",
    source: "3",
    target: "4",
    markerEnd: { type: MarkerType.Arrow, width: 20, height: 20 },
  },
  {
    id: "4->5",
    source: "4",
    target: "5",
    markerEnd: { type: MarkerType.Arrow, width: 20, height: 20 },
  },
  {
    id: "5->6",
    source: "5",
    target: "6",
    markerEnd: { type: MarkerType.Arrow, width: 20, height: 20 },
  },
  {
    id: "5->7",
    source: "5",
    target: "7",
    markerEnd: { type: MarkerType.Arrow, width: 20, height: 20 },
  },
];

export default function Flow() {
  const nodeTypes: NodeTypes = useMemo(
    () => ({ input_url: InputNode, action: ActionNode, review: ReviewNode }),
    []
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const [currentWorkflowRun, setCurrentWorkflowRun] = useState<
    { tag: string; accessToken: string } | undefined
  >(undefined);

  // We listen to changes in the runs for the current workflow run using the Trigger.dev realtime hooks.
  // We then pass the run data to its corresponding node, by filtering with the task identifier.
  // Alternatively, you could choose to listen to the run changes in the node components themselves. A couple of caveats with that approach:
  // - The implementation of the custom node components becomes a bit more involved. In the current implementation, they are mostly presentation-only components.
  // - Currently it is not possible to filter the runs in `useRealtimeRunsWithTag` to only listen to runs for a specific task. Only filtering by tag is supported.
  //   which the current implementation does not make use of. More filtering functionality might be added in the future though.
  const { runs } = useRealtimeRunsWithTag(currentWorkflowRun?.tag ?? [], {
    enabled: currentWorkflowRun !== undefined,
    accessToken: currentWorkflowRun?.accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  // Once the task in Trigger.dev is triggered, the unique tag for that run is set on the input node.
  // We need the unique tag and public access token to listen to the run status changes via the Trigger.dev realtime hooks.
  useEffect(() => {
    const inputNode = nodes.find((node) => isInputNode(node));
    if (!inputNode || inputNode.data.workflowRun?.tag === currentWorkflowRun?.tag) {
      return;
    }

    setCurrentWorkflowRun(inputNode.data.workflowRun);
  }, [nodes, currentWorkflowRun, setCurrentWorkflowRun]);

  // Update the node data on changes in the runs
  useEffect(() => {
    if (!runs || runs.length === 0) {
      return;
    }

    setNodes((nds) =>
      nds.map((node) => {
        if (isInputNode(node)) {
          return node;
        }

        const currentRun =
          runs.find(
            (run) =>
              run.taskIdentifier === node.data.trigger.taskIdentifier &&
              run.tags.includes(currentWorkflowRun?.tag as string)
          ) ?? undefined;

        if (isReviewNode(node)) {
          return {
            ...node,
            data: {
              ...node.data,
              trigger: {
                ...node.data.trigger,
                currentRun,
              },
            },
          };
        }

        return {
          ...node,
          data: {
            ...node.data,
            trigger: {
              ...node.data.trigger,
              currentRun,
            },
          },
        };
      })
    );
  }, [runs, setNodes]);

  // Animate the edges for an active workflow run based on the node status
  useEffect(() => {
    if (!currentWorkflowRun) {
      return;
    }

    setEdges((eds) => {
      return eds.map((edge) => {
        const sourceNode = nodes.find((node) => node.id === edge.source);

        if (!sourceNode || isInputNode(sourceNode)) {
          return edge;
        }

        return {
          ...edge,
          // A bit of a simplified approach.
          // You might want to differentiate further and style the edges differently if the status of a node is `FAILED`, for example.
          animated: sourceNode?.data?.trigger.currentRun?.status !== "COMPLETED",
        };
      });
    });
  }, [nodes, currentWorkflowRun, setEdges]);

  return (
    <div className="bg-slate-200/70 rounded-xl size-full overflow-hidden">
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        edges={edges}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
      />
    </div>
  );
}
