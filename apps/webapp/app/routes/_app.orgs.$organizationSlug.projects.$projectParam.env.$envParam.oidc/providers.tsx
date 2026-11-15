import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { Link, useSearchParams } from "@remix-run/react";
import type { ReactNode } from "react";
import { AnthropicLogoIcon } from "~/assets/icons/AnthropicLogoIcon";
import { AzureIcon } from "~/assets/icons/AiProviderIcons";
import { AWS } from "~/assets/icons/CloudProviderIcon";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { IDIcon } from "~/assets/icons/IDIcon";
import {
  DopplerIcon,
  HuggingFaceIcon,
  InfisicalIcon,
  OpenRouterIcon,
  VaultIcon,
} from "~/assets/icons/OidcProviderIcons";
import { GoogleLogo } from "~/assets/logos/GoogleLogo";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import tablerSpritePath from "~/components/primitives/tabler-sprite.svg";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { docsPath, v3EnvironmentVariableKeyPath } from "~/utils/pathBuilder";
import type {
  OidcReplaceableKey,
  OidcReplaceableService,
} from "~/v3/environmentVariables/oidcReplaceable";

export type Replaceable = Array<{ service: OidcReplaceableService; keys: OidcReplaceableKey[] }>;
export type OidcSetup = { issuer: string; subject: string; audience: string };

/** What every candidate page gets from the loader. */
export type OidcPageProps = {
  state: "development" | "available";
  setup: OidcSetup | null;
  replaceable: Replaceable;
};

// The selected provider, in the URL so it survives a reload and can be linked.
export const PROVIDER_PARAM = "provider";

// The audience a provider expects: fixed, or picked by the user (with a hint where it helps).
type Audience = { fixed: string } | { hint: string };

export type Provider = {
  id: string;
  name: string;
  description: string;
  guide: string;
  guideLabel: string;
  audience: Audience;
  /** A condition on the provider's side, shown in the setup. */
  note?: string;
};

// In the page's order. Ids match the replaceable table.
export const PROVIDERS: Provider[] = [
  {
    id: "aws",
    name: "Amazon Web Services",
    description: "Assume an IAM role instead of storing access keys.",
    guide: "oidc/aws",
    guideLabel: "AWS setup guide",
    audience: { fixed: "sts.amazonaws.com" },
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    description: "Sign in as an Entra app with a federated credential, no client secret.",
    guide: "oidc/azure",
    guideLabel: "Azure setup guide",
    audience: { fixed: "api://AzureADTokenExchange" },
  },
  {
    id: "gcp",
    name: "Google Cloud",
    description: "Call Google Cloud APIs with workload identity federation, no key file.",
    guide: "oidc/gcp",
    guideLabel: "Google Cloud setup guide",
    audience: { hint: "Your workload identity provider's URL." },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Call Claude without storing an Anthropic API key.",
    guide: "oidc/anthropic",
    guideLabel: "Anthropic setup guide",
    audience: { fixed: "https://api.anthropic.com" },
  },
  {
    id: "infisical",
    name: "Infisical",
    description: "Read secrets with your task's identity instead of a client secret.",
    guide: "oidc/infisical",
    guideLabel: "Infisical setup guide",
    audience: { hint: "Your Infisical site URL." },
  },
  {
    id: "vault",
    name: "HashiCorp Vault",
    description: "Log in with JWT auth instead of a long-lived Vault token.",
    guide: "oidc/vault",
    guideLabel: "Vault setup guide",
    audience: { hint: "Any value, as long as Vault and your task use the same one." },
  },
  {
    id: "doppler",
    name: "Doppler",
    description: "Fetch secrets as a service account identity, no Doppler token.",
    guide: "oidc/doppler",
    guideLabel: "Doppler setup guide",
    audience: { hint: "Any value, for example https://api.doppler.com." },
  },
  {
    id: "snowflake",
    name: "Snowflake",
    description: "Connect as a service user without a password or private key.",
    guide: "oidc/snowflake",
    guideLabel: "Snowflake setup guide",
    audience: { fixed: "snowflakecomputing.com" },
  },
  {
    id: "databricks",
    name: "Databricks",
    description: "Query Databricks as a service principal without a token.",
    guide: "oidc/databricks",
    guideLabel: "Databricks setup guide",
    audience: { hint: "Your Databricks account ID, or any value both sides share." },
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    description:
      "Run inference and read gated models or one repo without a token. Not a full user token.",
    guide: "oidc/hugging-face",
    guideLabel: "Hugging Face setup guide",
    audience: { fixed: "https://huggingface.co" },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Call models without storing an OpenRouter API key. Business or Enterprise plan.",
    guide: "oidc/openrouter",
    guideLabel: "OpenRouter setup guide",
    audience: { hint: "Any value, as long as your federation policy lists the same one." },
    note: "Workload identity needs OpenRouter's Business or Enterprise plan.",
  },
  {
    id: "custom",
    name: "Custom OIDC",
    description: "Any other service that accepts OIDC tokens.",
    guide: "oidc/custom",
    guideLabel: "Custom OIDC guide",
    audience: { hint: "The audience your service expects." },
  },
];

export function keysFor(replaceable: Replaceable, providerId: string) {
  return replaceable.find((group) => group.service.id === providerId)?.keys ?? [];
}

/** Providers with matched keys first, each group keeping the page's order. */
export function providersMatchedFirst(replaceable: Replaceable) {
  return [
    ...PROVIDERS.filter((provider) => keysFor(replaceable, provider.id).length > 0),
    ...PROVIDERS.filter((provider) => keysFor(replaceable, provider.id).length === 0),
  ];
}

export function countKeys(replaceable: Replaceable) {
  return replaceable.reduce((total, group) => total + group.keys.length, 0);
}

export function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The selected provider and links that select another one, keeping the rest of the query. */
export function useSelectedProvider() {
  const [searchParams] = useSearchParams();
  const selectedId = searchParams.get(PROVIDER_PARAM);
  const selected = PROVIDERS.find((provider) => provider.id === selectedId) ?? null;
  const hrefFor = (id: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (id) {
      params.set(PROVIDER_PARAM, id);
    } else {
      params.delete(PROVIDER_PARAM);
    }
    const query = params.toString();
    return query ? `?${query}` : "?";
  };
  return { selected, hrefFor };
}

function useKeyPath() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  // `env=all` and `search` so the list behind the key panel shows the key in every environment.
  return (key: string) =>
    `${v3EnvironmentVariableKeyPath(organization, project, environment, key)}?env=all&search=${encodeURIComponent(key)}`;
}

// Brand marks from the app's Tabler sprite.
function SpriteIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={cn("size-5", className)}>
      <use xlinkHref={`${tablerSpritePath}#${name}`} />
    </svg>
  );
}

// Each provider's mark, on the same neutral tile.
function markFor(id: string): ReactNode {
  switch (id) {
    case "aws":
      return <AWS className="size-7" />;
    case "azure":
      return <AzureIcon className="size-5 text-[#0089D6]" />;
    case "gcp":
      return <GoogleLogo className="size-5" />;
    case "anthropic":
      return <AnthropicLogoIcon className="size-5 text-text-bright" />;
    case "snowflake":
      return <SpriteIcon name="tabler-brand-snowflake" className="text-[#29B5E8]" />;
    case "databricks":
      return <SpriteIcon name="tabler-brand-databricks" className="text-[#FF3621]" />;
    case "infisical":
      return <InfisicalIcon className="w-6 text-text-bright" />;
    case "vault":
      return <VaultIcon className="size-5 text-[#FFCF25]" />;
    case "doppler":
      return <DopplerIcon className="size-5" />;
    case "huggingface":
      return <HuggingFaceIcon className="size-6" />;
    case "openrouter":
      return <OpenRouterIcon className="size-5 text-text-bright" />;
    default:
      return <IDIcon className="size-5 text-text-dimmed" />;
  }
}

export function ProviderMark({ id, className }: { id: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border border-grid-bright bg-background-dimmed",
        className
      )}
    >
      {markFor(id)}
    </span>
  );
}

export function ReplacesCount({ count, className }: { count: number; className?: string }) {
  return (
    <span className={cn("flex items-center gap-1.5 text-xs text-warning", className)}>
      <ExclamationTriangleIcon className="size-3.5 shrink-0" />
      Replaces {plural(count, "environment variable", "environment variables")}
    </span>
  );
}

/** A provider tile: a link that selects it. */
export function ProviderTile({
  provider,
  count,
  selected,
  to,
  className,
}: {
  provider: Provider;
  count: number;
  selected: boolean;
  to: string;
  className?: string;
}) {
  return (
    <Link
      to={to}
      preventScrollReset
      replace
      aria-current={selected ? "true" : undefined}
      data-provider-tile={provider.id}
      className={cn(
        "flex h-full flex-col gap-3 rounded-lg border bg-background-bright p-4 text-left transition-colors focus-custom",
        selected
          ? "border-indigo-500 bg-background-hover"
          : count > 0
            ? "border-warning/30 hover:border-warning/60 hover:bg-background-hover"
            : "border-grid-bright hover:border-border-bright hover:bg-background-hover",
        className
      )}
    >
      <span className="flex items-start gap-3">
        <ProviderMark id={provider.id} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-text-bright">{provider.name}</span>
          <span className="text-xs text-text-dimmed">{provider.description}</span>
        </span>
      </span>
      {count > 0 && <ReplacesCount count={count} className="mt-auto" />}
    </Link>
  );
}

/** Where a key is set, the way the env vars list shows environments. */
function SetIn({ item }: { item: OidcReplaceableKey }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {item.environmentTypes.map((type) => (
        <EnvironmentCombo
          key={type}
          environment={{ type }}
          className="text-xs text-text-dimmed"
          iconClassName="size-4"
        />
      ))}
      {item.previewBranches > 0 && (
        <span className="flex items-center gap-1.5 text-xs text-text-dimmed">
          <BranchEnvironmentIconSmall className="size-4 shrink-0 text-preview" />
          {plural(item.previewBranches, "branch", "branches")}
        </span>
      )}
    </span>
  );
}

function Value({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Paragraph variant="small/bright">{label}</Paragraph>
      {children}
    </div>
  );
}

/** Issuer URL and subject: the same for every provider. */
export function TokenValues({ setup }: { setup: OidcSetup }) {
  return (
    <>
      <Value label="Issuer URL">
        <ClipboardField value={setup.issuer} variant="secondary/small" />
      </Value>
      <Value label="Subject">
        <ClipboardField value={setup.subject} variant="secondary/small" />
      </Value>
    </>
  );
}

function AudienceValue({ audience }: { audience: Audience }) {
  return (
    <Value label="Audience">
      {"fixed" in audience ? (
        <ClipboardField value={audience.fixed} variant="secondary/small" />
      ) : (
        <Paragraph variant="small">You choose. {audience.hint}</Paragraph>
      )}
    </Value>
  );
}

/** One provider's setup: values to copy, the keys it replaces, and its guide. */
export function ProviderSetup({
  provider,
  setup,
  keys,
  showTokenValues = true,
}: {
  provider: Provider;
  setup: OidcSetup;
  keys: OidcReplaceableKey[];
  /** Off where the issuer and subject are already on screen. */
  showTokenValues?: boolean;
}) {
  const keyPath = useKeyPath();
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Header3>
          {showTokenValues
            ? `Values to copy into ${provider.name}`
            : `Copy the issuer URL and subject above into ${provider.name}, with this audience`}
        </Header3>
        {showTokenValues && <TokenValues setup={setup} />}
        <AudienceValue audience={provider.audience} />
        {provider.note && <Callout variant="info">{provider.note}</Callout>}
      </div>

      {keys.length > 0 && (
        <div className="space-y-2">
          <ReplacesCount count={keys.length} className="text-sm" />
          <Paragraph variant="small">
            Once your tasks sign in with OIDC, delete{" "}
            {keys.length === 1 ? "this variable." : "these variables."}
          </Paragraph>
          <ul className="space-y-2 rounded-md border border-grid-dimmed p-3">
            {keys.map((item) => (
              <li key={item.key} className="space-y-1">
                <TextLink to={keyPath(item.key)} className="block truncate font-mono text-xs">
                  {item.key}
                </TextLink>
                <SetIn item={item} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <LinkButton
        to={docsPath(provider.guide)}
        variant={keys.length > 0 ? "primary/medium" : "secondary/medium"}
        target="_blank"
      >
        {provider.guideLabel}
      </LinkButton>
    </div>
  );
}

/** The grid's heading line: what to do, depending on what matched. */
export function gridIntro(replaceable: Replaceable) {
  const total = countKeys(replaceable);
  if (total === 0) return "Pick a service to see what to copy into it and follow its guide.";
  return total === 1
    ? "1 environment variable holds a long-lived credential a service below can replace with OIDC."
    : `${total} environment variables hold long-lived credentials the services below can replace with OIDC.`;
}

/** The intro line and the callout every candidate starts with. */
export function OidcIntro({ state }: { state: OidcPageProps["state"] }) {
  return (
    <div className="space-y-4">
      <Paragraph>
        Let your tasks sign in to AWS and other services with short-lived tokens, instead of storing
        long-lived credentials in environment variables.
      </Paragraph>
      {state === "development" ? (
        <Callout variant="info">
          OIDC tokens are not available for local development. Choose a deployed environment to see
          its OIDC details.
        </Callout>
      ) : (
        <Callout variant="info">Use Trigger SDK and CLI version 4.8.3 or later.</Callout>
      )}
    </div>
  );
}

/** Issuer URL and subject side by side, for the top of the page. */
export function CompactTokenValues({ setup }: { setup: OidcSetup }) {
  return (
    <section className="@container space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <Header2>Token details</Header2>
        <Paragraph variant="small">The same for every service in this environment.</Paragraph>
      </div>
      <div className="grid grid-cols-1 gap-3 rounded-md border border-grid-dimmed bg-background-bright p-3 @2xl:grid-cols-2">
        <TokenValues setup={setup} />
      </div>
    </section>
  );
}

/** Tiles for the given providers, 1 to 4 across by the grid's own width. */
export function TileGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="@container">
      <ul
        className={cn(
          "grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3 @7xl:grid-cols-4",
          className
        )}
      >
        {children}
      </ul>
    </div>
  );
}
