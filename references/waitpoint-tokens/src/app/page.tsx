import React from "react";
import Flow from "@/components/Flow";
import Image from "next/image";
import logo from "./logo.svg";
import { auth } from "@trigger.dev/sdk";

export default async function Home() {
  // A user identifier that could be fetched from your auth mechanism.
  // This is out of scope for this example, so we just hardcode it.
  const user = "reactflowtest";
  const userTag = `user_${user}`;

  // We generate a public access token to use the Trigger.dev realtime API and listen to changes in task runs.
  // Depending on your setup, you might want to be more granular in the scopes you grant.
  // Check the frontend usage docs for a comprehensive list of the approaches to authenticate:
  // https://trigger.dev/docs/frontend/overview#authentication
  const publicAccessToken = await auth.createPublicToken({
    scopes: {
      read: {
        tags: [userTag],
      },
    },
  });

  return (
    <div className="flex flex-col items-center justify-center h-screen p-5 gap-5">
      <div className="flex flex-col items-center justify-center gap-2">
        <Image src={logo} alt="Logo" width={180} />
        <p className="text-sm text-zinc-500 max-w-[420px] text-center">
          This reference project that shows a possible approach to implement workflows using{" "}
          <span className="font-bold">Trigger.dev</span> and{" "}
          <span className="font-bold">ReactFlow</span>
        </p>
      </div>
      <div className="grow w-full max-w-[1500px]">
        <Flow triggerPublicAccessToken={publicAccessToken} triggerUserTag={userTag} />
      </div>
    </div>
  );
}
