import { UserGroupIcon } from "@heroicons/react/24/outline";
import { Header1 } from "~/components/primitives/Headers";
import { PageContainer } from "~/components/layout/PageContainer";
import { Paragraph } from "~/components/primitives/Paragraph";
export default function Members() {
  return (
    <PageContainer>
      <main className="flex h-full w-full items-center justify-center">
        <div className="flex min-w-[400px] flex-col items-center gap-y-3.5 rounded-md border border-slate-800 bg-slate-800 p-10 shadow-md">
          <UserGroupIcon className="h-10 w-10 text-indigo-500" />
          <Header1 className="">Manage team members</Header1>
          <Paragraph>
            We're working hard to bring Teams to Trigger.dev very soon.
          </Paragraph>
        </div>
      </main>
    </PageContainer>
  );
}
