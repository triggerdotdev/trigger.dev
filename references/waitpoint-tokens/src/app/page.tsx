import React from "react";
import Flow from "@/components/Flow";
import Image from "next/image";
import logo from "./logo.svg";

export default async function Home() {
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
        <Flow />
      </div>
    </div>
  );
}
