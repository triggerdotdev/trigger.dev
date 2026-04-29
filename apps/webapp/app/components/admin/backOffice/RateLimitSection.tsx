import { Form } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";

export const RATE_LIMIT_INTENT = "set-rate-limit";
export const RATE_LIMIT_SAVED_VALUE = "rate-limit";

// Local shape mirrors the server-side discriminated union just enough for this
// view. Decoupled from the .server module so the component stays client-safe.
export type RateLimitConfig =
  | {
      type: "tokenBucket";
      refillRate: number;
      interval: string | number;
      maxTokens: number;
    }
  | {
      type: "fixedWindow" | "slidingWindow";
      window: string | number;
      tokens: number;
    };

export type EffectiveRateLimit = {
  source: "override" | "default";
  config: RateLimitConfig;
};

type FieldErrors = Record<string, string[] | undefined> | null;

type Props = {
  effective: EffectiveRateLimit;
  errors: FieldErrors;
  savedJustNow: boolean;
  isSubmitting: boolean;
};

export function RateLimitSection({
  effective,
  errors,
  savedJustNow,
  isSubmitting,
}: Props) {
  const hasFieldErrors = !!errors && Object.keys(errors).length > 0;
  const fieldError = (field: string) =>
    errors && field in errors ? errors[field]?.[0] : undefined;

  const current =
    effective.config.type === "tokenBucket" ? effective.config : null;

  const [isEditing, setIsEditing] = useState(false);
  const [refillRate, setRefillRate] = useState(
    current ? String(current.refillRate) : ""
  );
  const [intervalStr, setIntervalStr] = useState(
    current ? String(current.interval) : ""
  );
  const [maxTokens, setMaxTokens] = useState(
    current ? String(current.maxTokens) : ""
  );

  useEffect(() => {
    if (hasFieldErrors) setIsEditing(true);
  }, [hasFieldErrors]);

  useEffect(() => {
    if (savedJustNow) setIsEditing(false);
  }, [savedJustNow]);

  const currentDescription = current
    ? describeRateLimit(
        current.refillRate,
        parseDurationToMs(String(current.interval)),
        current.maxTokens
      )
    : null;

  const previewDescription = describeRateLimit(
    Number(refillRate) || 0,
    parseDurationToMs(intervalStr),
    Number(maxTokens) || 0
  );

  const cancelEdit = () => {
    setRefillRate(current ? String(current.refillRate) : "");
    setIntervalStr(current ? String(current.interval) : "");
    setMaxTokens(current ? String(current.maxTokens) : "");
    setIsEditing(false);
  };

  return (
    <section className="flex flex-col gap-3 rounded-md border border-charcoal-700 bg-charcoal-800 p-4">
      <div className="flex items-center justify-between">
        <Header2>API rate limit</Header2>
        {!isEditing && (
          <Button
            variant="tertiary/small"
            onClick={() => setIsEditing(true)}
            disabled={isSubmitting || effective.config.type !== "tokenBucket"}
          >
            Edit
          </Button>
        )}
      </div>

      {savedJustNow && (
        <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2">
          <Paragraph variant="small" className="text-green-500">
            Saved.
          </Paragraph>
        </div>
      )}

      <Paragraph variant="small">
        Status:{" "}
        {effective.source === "override"
          ? "Custom override active."
          : "Using system default."}
      </Paragraph>

      {!isEditing ? (
        <>
          <Property.Table>
            {effective.config.type === "tokenBucket" ? (
              currentDescription ? (
                <>
                  <Property.Item>
                    <Property.Label>Sustained rate</Property.Label>
                    <Property.Value>
                      {currentDescription.sustained}
                    </Property.Value>
                  </Property.Item>
                  <Property.Item>
                    <Property.Label>Burst allowance</Property.Label>
                    <Property.Value>{currentDescription.burst}</Property.Value>
                  </Property.Item>
                </>
              ) : (
                <Property.Item>
                  <Property.Value>
                    Invalid interval on the stored config.
                  </Property.Value>
                </Property.Item>
              )
            ) : (
              <>
                <Property.Item>
                  <Property.Label>Type</Property.Label>
                  <Property.Value>{effective.config.type}</Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Window</Property.Label>
                  <Property.Value>{String(effective.config.window)}</Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Tokens</Property.Label>
                  <Property.Value>
                    {effective.config.tokens.toLocaleString()}
                  </Property.Value>
                </Property.Item>
              </>
            )}
          </Property.Table>
          {effective.config.type !== "tokenBucket" && (
            <Paragraph variant="small" className="text-amber-500">
              This override is a {effective.config.type} limit and can't be
              edited from this form. Change it in the database directly.
            </Paragraph>
          )}
        </>
      ) : (
        <Form method="post" className="flex flex-col gap-3 pt-2">
          <input type="hidden" name="intent" value={RATE_LIMIT_INTENT} />

          <div className="flex flex-col gap-1">
            <Label>Refill rate (tokens per interval)</Label>
            <Input
              name="refillRate"
              type="number"
              min={1}
              value={refillRate}
              onChange={(e) => setRefillRate(e.target.value)}
              required
            />
            <FormError>{fieldError("refillRate")}</FormError>
          </div>

          <div className="flex flex-col gap-1">
            <Label>Interval (e.g. 10s, 1m)</Label>
            <Input
              name="interval"
              type="text"
              value={intervalStr}
              onChange={(e) => setIntervalStr(e.target.value)}
              required
            />
            <FormError>{fieldError("interval")}</FormError>
          </div>

          <div className="flex flex-col gap-1">
            <Label>Max tokens (burst allowance)</Label>
            <Input
              name="maxTokens"
              type="number"
              min={1}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              required
            />
            <FormError>{fieldError("maxTokens")}</FormError>
          </div>

          <Paragraph variant="small" className="text-text-dimmed">
            {previewDescription
              ? `Preview: ${previewDescription.sustained} · ${previewDescription.burst}.`
              : "Preview: enter valid values to see the effective limit."}
          </Paragraph>

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary/medium"
              disabled={
                isSubmitting ||
                !refillRate.trim() ||
                !intervalStr.trim() ||
                !maxTokens.trim()
              }
            >
              Save
            </Button>
            <Button
              type="button"
              variant="tertiary/medium"
              onClick={cancelEdit}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          </div>
        </Form>
      )}
    </section>
  );
}

export function parseDurationToMs(duration: string): number {
  const match = duration.trim().match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      return 0;
  }
}

function describeRateLimit(
  refillRate: number,
  intervalMs: number,
  maxTokens: number
): { sustained: string; burst: string } | null {
  if (refillRate <= 0 || intervalMs <= 0 || maxTokens <= 0) return null;
  const perMin = (refillRate * 60_000) / intervalMs;
  let sustained: string;
  if (perMin >= 1) {
    sustained = `${Math.round(perMin).toLocaleString()} requests per minute`;
  } else {
    const perHour = perMin * 60;
    if (perHour >= 1) {
      sustained = `${Math.round(perHour).toLocaleString()} requests per hour`;
    } else {
      const perDay = perHour * 24;
      const formatted =
        perDay >= 10 ? Math.round(perDay).toLocaleString() : perDay.toFixed(1);
      sustained = `${formatted} requests per day`;
    }
  }
  return {
    sustained,
    burst: `${maxTokens.toLocaleString()} request burst allowance`,
  };
}
