import { UserGroupIcon } from "@heroicons/react/24/outline";
import { Container } from "~/components/layout/Container";
import { Body } from "~/components/primitives/text/Body";
import { Header1 } from "~/components/primitives/text/Headers";
export default function Members() {
  return (
    <Container>
      <main className="w-full h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-y-3.5 min-w-[400px] bg-slate-800 border border-slate-800 rounded-md p-10">
          <UserGroupIcon className="h-10 w-10 text-indigo-500" />
          <Header1 size="large" className="">
            Manage team members
          </Header1>

          <Body>
            We're working hard to bring Teams to Trigger.dev very soon.
          </Body>
        </div>
      </main>
    </Container>
  );
}
