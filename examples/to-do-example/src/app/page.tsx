import { SummaryEmailCard } from "./components/Cards";
import { Header1, Header2 } from "./components/Header";
import { Paragraph } from "./components/Paragraph";
import { PrimaryGradientText } from "./components/TextStyling";
import { ToDoRow } from "./components/ToDoRow";

export default function Home() {
  return (
    <main className="grid grid-cols-3 h-screen bg-midnight-950">
      <div className="flex flex-col pt-40 h-full px-12">
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
      <div className="h-full w-full items-center pt-40 flex flex-col px-2">
        <Header1 variant="base/bold" className="mb-6">
          <PrimaryGradientText>To-do list</PrimaryGradientText>
        </Header1>
        <div className="flex flex-col w-full gap-y-4">
          <ToDoRow variant="add" />
          <ToDoRow variant="active" />
          <ToDoRow variant="completed" />
        </div>
      </div>
      <div className="h-full w-full pt-40 flex flex-col px-8">
        <Paragraph variant="small" capitalize>
          Trigger.dev jobs
        </Paragraph>
        <div className="flex w-full justify-center items-center">
          <div className="rounded full h-1 w-1 bg-red-500" />
          <Paragraph
            variant="extraSmall"
            removeBottomPadding
            className="px-2"
            capitalize
          >
            Inactive
          </Paragraph>
          <div className="rounded-full h-px w-full bg-slate-800" />
        </div>
        <SummaryEmailCard active={false} />
      </div>
<form className="mt-8"><div className="bg-neutral-900 w-full border border-neutral-600 rounded-lg focus-within:ring-2 focus-within:ring-current focus-within:outline-none focus-within:border-current focus-within:ring-offset-2 flex overflow-hidden relative z-10"><label for="email" className="sr-only">Email</label><input id="email" type="email" placeholder="hello@example.com" className="bg-inherit placeholder:text-neutral-500 placeholder:font-normal text-neutral-50 p-4 w-full focus-visible:outline-none font-semibold" name="email" value=""><div className="p-2"><button type="submit" className="flex h-full rounded-[4px] items-center w-10 justify-center bg-neutral-50 text-neutral-900"><span className="sr-only">Subscribe</span><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><line x1="4.75" y1="12" x2="19" y2="12"></line><line x1="13.75" y1="6.75" x2="19" y2="12"></line><line x1="19" y1="12" x2="13.75" y2="17.25"></line><g><line x1="3" y1="3" x2="6" y2="12" opacity="0" pathLength="1" stroke-dashoffset="0px" stroke-dasharray="0px 1px"></line><line x1="3" y1="21" x2="6" y2="12" opacity="0" pathLength="1" stroke-dashoffset="0px" stroke-dasharray="0px 1px"></line></g></svg></button></div></div><p className="mt-2 text-sm">No spam. Unsubscribe anytime.</p></form>
    </main>
  );
}


