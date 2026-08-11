import { ArrowRightIcon, ArrowTopRightOnSquareIcon, CogIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { cn } from "~/utils/cn";

/*
 * TEMPORARY - delete once the underline decisions are made.
 *
 * Every link in the app that underlines itself instead of going through TextLink,
 * so the "Underline links" preference doesn't reach it. Each is copied verbatim
 * from its source (classes and markup) and dropped into enough of its
 * surroundings to recognise. Labels match the audit table.
 */

function Row({
  id,
  file,
  line,
  kind,
  note,
  children,
}: {
  id: string;
  file: string;
  line: string;
  kind: "internal" | "external" | "hover-only" | "not-a-link";
  note?: string;
  children: React.ReactNode;
}) {
  const kindStyle = {
    internal: "bg-blue-500/10 text-blue-500",
    external: "bg-purple-500/10 text-purple-500",
    "hover-only": "bg-amber-500/10 text-amber-500",
    "not-a-link": "bg-charcoal-500/20 text-text-dimmed",
  }[kind];

  return (
    <div className="grid grid-cols-[3rem_1fr] gap-x-4 border-b border-grid-dimmed py-4">
      <div className="pt-0.5 font-mono text-sm text-text-bright">{id}</div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-text-dimmed">
            {file}:{line}
          </span>
          <span className={cn("rounded px-1.5 py-0.5 text-xxs uppercase", kindStyle)}>{kind}</span>
        </div>
        {note ? <Paragraph variant="extra-small">{note}</Paragraph> : null}
        <div className="rounded border border-grid-bright bg-background-bright p-4">{children}</div>
      </div>
    </div>
  );
}

function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <div className="border-b border-grid-bright pb-2">
        <Header2>{title}</Header2>
      </div>
      <Paragraph variant="small" className="mt-2">
        {blurb}
      </Paragraph>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export default function Story() {
  return (
    <div className="max-w-[50rem] p-8">
      <Header1>Underline audit</Header1>
      <Paragraph variant="small" className="mt-2">
        Temporary page. Links below underline themselves rather than using{" "}
        <TextLink to="/storybook/typography">TextLink</TextLink>, so the "Underline links"
        preference leaves them as they are. Toggle the preference in Your profile to compare - only
        the TextLink above should change.
      </Paragraph>

      <Section
        title="A. Hard-coded underline, always on"
        blurb="These are underlined whatever the preference says. Candidates for moving onto TextLink."
      >
        <Row
          id="A1"
          file="primitives/LabelValueStack.tsx"
          line="72"
          kind="internal"
          note="ValueButton, internal branch. Used in property tables - a value that happens to be a path. reloadDocument."
        >
          <Paragraph variant="small">Label</Paragraph>
          <Paragraph variant="small/bright">
            <Link to="/storybook" reloadDocument className="underline underline-offset-2">
              /orgs/acme/projects/my-project
            </Link>
          </Paragraph>
        </Row>

        <Row
          id="A2"
          file="primitives/LabelValueStack.tsx"
          line="84"
          kind="external"
          note="Same component, external branch: adds the open-in-new icon and a tooltip of the full href."
        >
          <Paragraph variant="small">Label</Paragraph>
          <Paragraph variant="small/bright">
            <a href="https://trigger.dev" className="underline underline-offset-2" target="_blank">
              https://trigger.dev
              <ArrowTopRightOnSquareIcon className="ml-1 inline-block h-4 w-4 text-text-dimmed" />
            </a>
          </Paragraph>
        </Row>

        <Row
          id="A3"
          file="navigation/NotificationCard.tsx"
          line="112"
          kind="external"
          note="Markdown renderer for notification bodies: any link an author writes lands here. Sits inside a clickable card, hence the z-index and stopPropagation."
        >
          <p className="my-0.5 text-xs leading-normal text-text-dimmed">
            We've shipped preview branches.{" "}
            <a
              href="https://trigger.dev/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="relative z-20 text-indigo-400 underline transition-colors hover:text-indigo-300"
            >
              Read the docs
            </a>{" "}
            to get started.
          </p>
        </Row>

        <Row
          id="A4"
          file="dashboard-agent/RunDiagnosisCard.tsx"
          line="63"
          kind="internal"
          note="RunLink: a run id inside agent diagnosis prose. Note indigo-400, a stop lighter than TextLink's indigo-500."
        >
          <p className="text-sm text-text-dimmed">
            The failure first appears in{" "}
            <Link
              to="/storybook"
              className={cn("text-indigo-400 underline hover:text-indigo-300", "font-mono text-xs")}
            >
              run_c8a91k2p0x
            </Link>{" "}
            and repeats on every retry.
          </p>
        </Row>

        <Row
          id="A5"
          file="dashboard-agent/RunDiagnosisCard.tsx"
          line="83"
          kind="external"
          note="EvidenceReference: the same card's evidence list, when the reference is a URL rather than a run id."
        >
          <ul className="space-y-1 text-sm text-text-dimmed">
            <li>
              Evidence:{" "}
              <a
                href="https://status.example.com/incidents/42"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-indigo-400 underline hover:text-indigo-300"
              >
                https://status.example.com/incidents/42
              </a>
            </li>
            <li>
              Evidence: <span className="font-mono text-xs text-text-dimmed">error_9f2b1c</span>
            </li>
          </ul>
        </Row>

        <Row
          id="A6"
          file="runs/v3/agent/AgentMessageView.tsx"
          line="222"
          kind="external"
          note="Citation list under an agent message - a cited source's title."
        >
          <div className="text-xs">
            <a
              href="https://trigger.dev/docs/tasks"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 underline hover:text-indigo-300"
            >
              Writing tasks - Trigger.dev docs
            </a>
          </div>
        </Row>

        <Row
          id="A7"
          file="runs/v3/agent/AgentMessageView.tsx"
          line="277"
          kind="external"
          note="Same view, file attachment on an agent message. Falls back to 'Download file' with no filename."
        >
          <div className="text-xs">
            <a
              href="https://example.com/report.csv"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 underline hover:text-indigo-300"
            >
              report.csv
            </a>
          </div>
        </Row>

        <Row
          id="A8"
          file="billing/BillingLimitConfigSection.tsx"
          line="341"
          kind="external"
          note="Mid-sentence in a paragraph of billing explainer text. Bare underline, inherits the surrounding colour."
        >
          <Paragraph variant="small">
            When this limit is reached, queued runs will be held for 24 hours, then new triggers
            will be rejected until you increase or remove the limit. See our{" "}
            <a href="https://trigger.dev/terms" className="underline">
              terms
            </a>{" "}
            for refund policy details.
          </Paragraph>
        </Row>

        <Row
          id="A9"
          file="ProductHuntBanner.tsx"
          line="17"
          kind="external"
          note="A LinkButton, not an anchor - underline is passed in via className on top of the tertiary/small button. On a coloured banner."
        >
          <div className="flex h-8 items-center justify-center gap-2 bg-[#ff6154]">
            <Paragraph variant="small" className="text-white">
              We're live on{" "}
            </Paragraph>
            <span className="text-sm font-semibold text-white">Product Hunt</span>
            <ArrowRightIcon className="h-4 w-4 text-white" />
            <span className="text-white! text-sm underline underline-offset-2 transition hover:decoration-text-bright hover:decoration-2">
              Vote for us today only!
            </span>
          </div>
        </Row>

        <Row
          id="A10"
          file="routes/admin._index.tsx"
          line="123"
          kind="external"
          note="Admin users table: a GitHub profile link in a table cell."
        >
          <div className="text-sm">
            <a
              href="https://github.com/samejr"
              target="_blank"
              className="text-indigo-500 underline"
              rel="noreferrer"
            >
              samejr
            </a>
          </div>
        </Row>

        <Row
          id="A11"
          file="routes/admin.llm-models._index.tsx"
          line="253"
          kind="internal"
          note="Admin model matcher result. Underline inherits the green 'Match:' colour."
        >
          <div className="text-green-400">
            Match:{" "}
            <Link to="/storybook" className="font-medium underline">
              claude-opus-4-20250514
            </Link>
          </div>
        </Row>

        <Row
          id="A12"
          file="routes/admin.llm-models._index.tsx"
          line="308"
          kind="internal"
          note="Admin models table: the model name cell, linking to its detail page."
        >
          <div className="text-sm">
            <Link to="/storybook" className="font-medium text-indigo-500 underline">
              claude-sonnet-4-20250514
            </Link>
          </div>
        </Row>

        <Row
          id="A13"
          file="routes/admin.llm-models.missing._index.tsx"
          line="135"
          kind="internal"
          note="Another LinkButton with underline passed in - minimal/small, monospace, in a table cell."
        >
          <div className="font-mono text-sm text-indigo-500 underline">gpt-4o-mini-2024-07-18</div>
        </Row>

        <Row
          id="A14"
          file="routes/…env.$envParam.deployments/route.tsx"
          line="384"
          kind="external"
          note="Deployments header: the connected GitHub repo, dimmed with a hover to bright, next to a settings cog."
        >
          <div className="flex items-center gap-1 text-sm text-text-dimmed">
            <span>Deploying from</span>
            <a
              href="https://github.com/triggerdotdev/trigger.dev"
              target="_blank"
              rel="noreferrer noopener"
              className="max-w-52 truncate text-sm text-text-dimmed underline transition-colors hover:text-text-bright"
            >
              triggerdotdev/trigger.dev
            </a>
            <CogIcon className="size-4 text-text-dimmed" />
          </div>
        </Row>

        <Row
          id="A15"
          file="routes/…deployments.$deploymentParam/route.tsx"
          line="327"
          kind="internal"
          note="Deployment detail property table: the build server id, linking to its logs."
        >
          <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
            <span className="text-text-dimmed">Build Server</span>
            <span>
              <Link to="/storybook" className="extra-small/bright/mono underline">
                bld_7ac91f2
              </Link>
            </span>
          </div>
        </Row>
      </Section>

      <Section
        title="B. Underline on hover only"
        blurb="No underline at rest, so these already read as the preference being off. Turning it on wouldn't touch them either."
      >
        <Row
          id="B1"
          file="runs/v3/ai/AIToolsInventory.tsx"
          line="51"
          kind="hover-only"
          note="A <button>, not a link - it expands a schema. Styled as a link with text-text-link."
        >
          <div className="pl-3.5">
            <button className="text-[10px] text-text-link hover:underline">Show schema</button>
          </div>
        </Row>

        <Row
          id="B2"
          file="routes/…settings.team/route.tsx"
          line="469"
          kind="hover-only"
          note="Section header action, aligned opposite a Header2."
        >
          <div className="flex items-baseline justify-between">
            <Header2>Active team members</Header2>
            <a className="text-xs text-text-link hover:underline" href="/storybook">
              View all role permissions →
            </a>
          </div>
        </Row>

        <Row
          id="B3-B7"
          file="routes/…query/TRQLGuideContent.tsx"
          line="84, 87, 90, 93, 96"
          kind="hover-only"
          note="Table of contents in the TRQL guide sidebar: five in-page anchors, one per line."
        >
          <nav className="space-y-1 text-sm">
            <a href="#basic" className="block text-text-link hover:underline">
              Basic queries
            </a>
            <a href="#filtering" className="block text-text-link hover:underline">
              Filtering with WHERE
            </a>
            <a href="#sorting" className="block text-text-link hover:underline">
              Sorting &amp; limiting
            </a>
            <a href="#grouping" className="block text-text-link hover:underline">
              Grouping &amp; aggregation
            </a>
            <a href="#functions" className="block text-text-link hover:underline">
              Available functions
            </a>
          </nav>
        </Row>
      </Section>

      <Section
        title="C. Underlined, but not links"
        blurb="Listed so they're accounted for. These shouldn't follow a links preference - they use the underline as a different signal."
      >
        <Row
          id="C1"
          file="DefinitionTooltip.tsx"
          line="20"
          kind="not-a-link"
          note="Dashed underline marking a term that reveals a tooltip."
        >
          <Paragraph variant="small">
            Runs can be{" "}
            <span className="cursor-default underline decoration-text-faint decoration-dashed underline-offset-4 transition hover:decoration-text-dimmed">
              debounced
            </span>{" "}
            before they queue.
          </Paragraph>
        </Row>

        <Row
          id="C2"
          file="routes/…select-plan.tsx"
          line="605, 759, 819"
          kind="not-a-link"
          note="Three hoverable spans on the plan cards, same dashed treatment as C1."
        >
          <Paragraph variant="small">
            Includes{" "}
            <span className="cursor-pointer underline decoration-text-faint underline-offset-4 transition hover:decoration-text-bright">
              100,000 runs
            </span>{" "}
            per month.
          </Paragraph>
        </Row>

        <Row
          id="C3"
          file="integrations/VercelOnboardingModal.tsx"
          line="1002, 1085"
          kind="not-a-link"
          note="Dotted yellow underline flagging a value that needs attention, plus its legend."
        >
          <div className="space-y-2">
            <div className="min-w-0 max-w-full cursor-default truncate text-left font-mono text-xs underline decoration-yellow-500 decoration-dotted underline-offset-2">
              NEXT_PUBLIC_API_URL
            </div>
            <Paragraph variant="extra-small">
              Values with a{" "}
              <span className="underline decoration-yellow-500 decoration-dotted underline-offset-2">
                underline
              </span>{" "}
              will be overwritten.
            </Paragraph>
          </div>
        </Row>

        <Row
          id="C4"
          file="routes/admin.notifications.tsx"
          line="883, 1239"
          kind="not-a-link"
          note="A URL shown as text in a <p> - underlined but not clickable."
        >
          <p className="text-sm text-text-dimmed underline">
            https://cloud.trigger.dev/orgs/acme/projects/my-project
          </p>
        </Row>

        <Row
          id="C5"
          file="code/TSQLResultsTable.tsx"
          line="838"
          kind="not-a-link"
          note="Focus affordance only: [&_a:focus-visible]:underline on cells in the query results table. Tab to the link to see it."
        >
          <div className="[&_a:focus-visible]:underline [&_a:focus-visible]:underline-offset-[3px] [&_a:focus-visible]:outline-hidden">
            <a href="/storybook" className="text-sm text-text-bright">
              run_c8a91k2p0x
            </a>
          </div>
        </Row>
      </Section>

      <Section
        title="Reference: TextLink as it is today"
        blurb="The component the preference does reach. Both variants are colour-only until the preference is on; every one of the 70 call sites uses primary."
      >
        <Row
          id="—"
          file="primitives/TextLink.tsx"
          line="11-14"
          kind="internal"
          note="For comparison."
        >
          <div className="space-y-2">
            <Paragraph variant="small">
              Primary: <TextLink to="/storybook">an internal link</TextLink> and{" "}
              <TextLink href="https://trigger.dev/docs">an external one</TextLink>.
            </Paragraph>
            <Paragraph variant="small">
              Secondary (no call sites today):{" "}
              <TextLink to="/storybook" variant="secondary">
                a secondary link
              </TextLink>
              .
            </Paragraph>
          </div>
        </Row>
      </Section>
    </div>
  );
}
