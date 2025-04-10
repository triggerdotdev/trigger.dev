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
import { TriggerAuthContext } from "@trigger.dev/react-hooks";

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

type WorkflowNode = InputNodeData | ActionNodeData | ReviewNodeData;

export default function Flow({
  triggerPublicAccessToken,
  triggerUserTag,
}: {
  triggerPublicAccessToken: string;
  triggerUserTag: string;
}) {
  const initialNodes: WorkflowNode[] = useMemo(
    () =>
      [
        {
          id: "1",
          type: "input_url",
          position: { x: 0, y: 150 },
          data: {
            trigger: {
              currentRunTag: undefined,
            },
          },
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
              userTag: triggerUserTag,
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
              userTag: triggerUserTag,
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
              userTag: triggerUserTag,
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
              userTag: triggerUserTag,
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
              userTag: triggerUserTag,
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
              taskIdentifier:
                "send-slack-notification" satisfies (typeof sendSlackNotification)["id"],
              userTag: triggerUserTag,
            },
          },
        },
      ] satisfies WorkflowNode[],
    [triggerUserTag]
  );
  const initialEdges: Edge[] = useMemo(
    () => [
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
    ],
    []
  );

  const nodeTypes: NodeTypes = useMemo(
    () => ({ input_url: InputNode, action: ActionNode, review: ReviewNode }),
    []
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const [currentRunTag, setCurrentRunTag] = useState<string | undefined>(undefined);

  // Once the task in Trigger.dev is triggered, the unique tag for that run is set on the input node.
  // We propagate this run tag to the other nodes here.
  // An alternative approach to avoid doing the propagation at the root level
  // would be to do this in the nodes themselves by using the `useNodeConnections` hook from ReactFlow.
  useEffect(() => {
    const inputNode = nodes.find((node) => isInputNode(node));
    if (!inputNode || inputNode.data.trigger.currentRunTag === currentRunTag) {
      return;
    }

    setCurrentRunTag(inputNode.data.trigger.currentRunTag);
  }, [nodes, currentRunTag, setCurrentRunTag]);

  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => {
        if (isInputNode(node)) {
          return node;
        }

        if (isReviewNode(node)) {
          return {
            ...node,
            data: {
              ...node.data,
              trigger: {
                ...node.data.trigger,
                currentRunTag,
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
              currentRunTag,
            },
          },
        };
      })
    );
  }, [currentRunTag, setNodes]);

  // Animate the edges for an active workflow run based on the node status
  useEffect(() => {
    if (!currentRunTag) {
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
          animated: sourceNode?.data?.trigger.currentRunStatus !== "COMPLETED",
        };
      });
    });
  }, [nodes, currentRunTag, setEdges]);

  return (
    <div className="bg-slate-200/70 rounded-xl size-full overflow-hidden">
      <TriggerAuthContext.Provider
        value={{
          accessToken: triggerPublicAccessToken,
          baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
        }}
      >
        <ReactFlow
          nodes={nodes}
          onNodesChange={onNodesChange}
          edges={edges}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
        />
      </TriggerAuthContext.Provider>
    </div>
  );
}
