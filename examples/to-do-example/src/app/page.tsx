import Image from "next/image";
import { Header2, Header3 } from "./components/Header";
import { Paragraph } from "./components/Paragraph";

export default function Home() {
  return (
    <main className="grid grid-cols-3 h-screen bg-midnight-950">
      <div className="flex flex-col justify-center h-full px-12">
        <Header2 variant="small/semibold">To-do list example project</Header2>
        <div className="pb-2 flex">
          <Paragraph variant="small/medium" className="text-slate-500">
            Powered by
          </Paragraph>
        </div>
        <Paragraph variant="base">
          This project demonstrates some of the key features of Trigger.dev.{" "}
        </Paragraph>
        <div className="h-px bg-slate-800 rounded-full w-full" />
        <div className="flex flex-col pt-8 gap-y-2">
          <Paragraph variant="base" removeBottomPadding>
            <a
              rel="noopener noreferrer"
              target="_blank"
              href="https://github.com/trigger.dev/to-do-list-example"
              className="text-indigo-400 hover:underline hover:underline-offset-2 transition"
            >
              trigger.dev/to-do-list-example
            </a>
          </Paragraph>
          <Paragraph variant="base" removeBottomPadding>
            View the{" "}
            <a
              rel="noopener noreferrer"
              target="_blank"
              href=""
              className="text-indigo-400 hover:underline hover:underline-offset-2 transition"
            >
              source code
            </a>
            .
          </Paragraph>
          <Paragraph variant="base" removeBottomPadding>
            View the{" "}
            <a
              rel="noopener noreferrer"
              target="_blank"
              href=""
              className="text-indigo-400 hover:underline hover:underline-offset-2 transition"
            >
              docs
            </a>
            .
          </Paragraph>
        </div>
      </div>
      <div className="h-full bg-slate-800"></div>
      <div className="h-full bg-slate-900"></div>
    </main>
  );
}
