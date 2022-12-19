import CodeBlock from "./code/CodeBlock";
import { Body } from "./primitives/text/Body";
import { Header1, Header2 } from "./primitives/text/Headers";

export default function CreateNewWorkflow() {
  return (
    <>
      <Header1 className="mb-6">Create a Workflow</Header1>
      <Header2 size="small" className="mb-2 text-slate-400">
        Step 1.
      </Header2>
      <Body>
        Create a workflow in your code then trigger your workflow using the test
        button to see the runs appear here.
      </Body>
      <CodeBlock code={codeExample1} />
    </>
  );
}

const codeExample1 = `new Workflow({
    name: "Sync Github issues to Linear",
    trigger: onIssue({
        repo: "acme/website",
    }),
    run: async (event, io, ctx) => {
        const { issue, action } = event;
    
        const assignee = await findUserByGithubId(issue.assignee?.id);
    
        if (action === "opened") {
        await io.linear.issueCreate({
            id: issue.id,
            title: issue.title,
            description: issue.body,
            assigneeId: assignee?.linearId,
            teamId: ctx.env.LINEAR_TEAM_ID,
        });
        } else {
        await io.linear.issueUpdate(issue.id, {
            assigneeId: assignee?.linearId,
            stateId:
            action === "closed"
                ? ctx.env.LINEAR_CLOSED_STATE_ID
                : ctx.env.LINEAR_OPEN_STATE_ID,
        });
        }
    },
    }).listen();`;
