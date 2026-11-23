import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { UserAvatar } from "~/components/UserProfilePhoto";
import type {
  AuditLogActorView,
  AuditLogEventView,
} from "~/presenters/v3/AuditLogPresenter.server";
import { cn } from "~/utils/cn";
import { AUDIT_LOG_CATEGORY_COLORS } from "./auditLogEvents";

export function AuditLogActor({ actor }: { actor: AuditLogActorView }) {
  return (
    <span className="flex items-center gap-1.5">
      <AuditLogActorBadge actor={actor} />
      {/* Colour comes from where it's shown: dim in a table row until hovered, bright in the panel. */}
      <span
        className={cn(actor.kind === "credential" && actor.credential === "key" && "font-mono")}
      >
        {actor.label}
      </span>
    </span>
  );
}

/**
 * Who acted, at a glance: a person's avatar, or a square for what isn't a person (K for an API key,
 * T for a token, a cog for Trigger.dev), and TD for Trigger.dev support.
 */
function AuditLogActorBadge({ actor }: { actor: AuditLogActorView }) {
  if (actor.kind === "user" && !actor.withPat) {
    return <UserAvatar avatarUrl={actor.avatarUrl} name={actor.name} className="size-5 shrink-0" />;
  }
  const badge =
    actor.kind === "user" || (actor.kind === "credential" && actor.credential === "token")
      ? { text: "T", className: "rounded bg-purple-500/15 text-purple-300" }
      : actor.kind === "credential"
        ? { text: "K", className: "rounded bg-amber-500/15 text-amber-300" }
        : actor.kind === "support"
          ? { text: "TD", className: "rounded-full bg-rose-500/15 text-rose-300" }
          : actor.kind === "run"
            ? { text: "R", className: "rounded bg-sky-500/15 text-sky-300" }
            : { text: "⚙", className: "rounded bg-emerald-500/15 text-emerald-300" };
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center text-[10px] font-semibold",
        badge.className
      )}
    >
      {badge.text}
    </span>
  );
}

export function AuditLogAction({
  category,
  label,
}: {
  category: AuditLogEventView["category"];
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-full", AUDIT_LOG_CATEGORY_COLORS[category])} />
      <span>{label}</span>
    </span>
  );
}

export function AuditLogTarget({ event }: { event: AuditLogEventView }) {
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono">{targetLabel(event)}</span>
      {event.project ? <span className="text-text-dimmed">{event.project.name}</span> : null}
      {event.environment ? (
        <EnvironmentLabel environment={event.environment} disableTooltip />
      ) : null}
    </span>
  );
}

/**
 * What an event acted on. A support session covers the whole organization, and names the user
 * support signed in as.
 */
export function targetLabel(event: AuditLogEventView) {
  if (event.category === "support") {
    return event.target.type === "user" && event.target.name
      ? `Organization (as ${event.target.name})`
      : "Organization";
  }
  // A root key is recorded without a name: its environment, shown beside it, says which one.
  if (event.target.type === "root_api_key" && !event.target.name) return "Root API key";
  return event.target.name ?? event.target.id ?? event.target.type;
}
