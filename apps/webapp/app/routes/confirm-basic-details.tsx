import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ArrowRightIcon, EnvelopeIcon, UserGroupIcon, UserIcon } from "@heroicons/react/20/solid";
import { HandRaisedIcon } from "@heroicons/react/24/solid";
import { RadioGroup } from "@radix-ui/react-radio-group";
import { json, type ActionFunction } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { motion } from "framer-motion";
import { forwardRef, useEffect, useState } from "react";
import { z } from "zod";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { RadioGroupItem } from "~/components/primitives/RadioButton";
import { Select, SelectItem } from "~/components/primitives/Select";
import { prisma } from "~/db.server";
import { useFeatures } from "~/hooks/useFeatures";
import { useUser } from "~/hooks/useUser";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { updateUser } from "~/models/user.server";
import { requireUserId } from "~/services/session.server";
import { rootPath } from "~/utils/pathBuilder";
import { getVercelInstallParams } from "~/v3/vercel";

const referralSourceOptions = [
  "Search engine",
  "YouTube",
  "Twitter/X",
  "LinkedIn",
  "Word of mouth",
  "AI assistant/LLM",
  "Blog/article",
  "Event",
  "Other",
] as const;

const roleOptions = [
  "Founder",
  "Staff/principal engineer",
  "Senior software engineer",
  "Software engineer",
  "AI/ML engineer",
  "Engineering manager",
  "Product engineer",
  "Non technical builder using AI tools",
  "Student/learner",
  "Other",
] as const;

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function createSchema(
  constraints: {
    isEmailUnique?: (email: string) => Promise<boolean>;
  } = {}
) {
  return z
    .object({
      name: z.string().min(3, "Your name must be at least 3 characters").max(50),
      email: z
        .string()
        .email()
        .superRefine((email, ctx) => {
          if (constraints.isEmailUnique === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: conform.VALIDATION_UNDEFINED,
            });
          } else {
            return constraints.isEmailUnique(email).then((isUnique) => {
              if (isUnique) {
                return;
              }

              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Email is already being used by a different account",
              });
            });
          }
        }),
      confirmEmail: z.string(),
      referralSource: z.string().optional(),
      referralSourceOther: z.string().optional(),
      role: z.string().optional(),
      roleOther: z.string().optional(),
    })
    .refine((value) => value.email === value.confirmEmail, {
      message: "Emails must match",
      path: ["confirmEmail"],
    });
}

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);
  const formData = await request.formData();

  const formSchema = createSchema({
    isEmailUnique: async (email) => {
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
        },
      });

      if (!existingUser) {
        return true;
      }

      if (existingUser.id === userId) {
        return true;
      }

      return false;
    },
  });

  const submission = await parse(formData, { schema: formSchema, async: true });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const onboardingData: Record<string, string | undefined> = {};

    if (submission.value.referralSource) {
      onboardingData.referralSource = submission.value.referralSource;
      if (submission.value.referralSource === "Other" && submission.value.referralSourceOther) {
        onboardingData.referralSourceOther = submission.value.referralSourceOther;
      }
    }

    if (submission.value.role) {
      onboardingData.role = submission.value.role;
      if (submission.value.role === "Other" && submission.value.roleOther) {
        onboardingData.roleOther = submission.value.roleOther;
      }
    }

    const referralSourceForLegacy =
      submission.value.referralSource === "Other" && submission.value.referralSourceOther
        ? `Other: ${submission.value.referralSourceOther}`
        : submission.value.referralSource;

    await updateUser({
      id: userId,
      name: submission.value.name,
      email: submission.value.email,
      referralSource: referralSourceForLegacy,
      onboardingData,
    });

    const vercelParams = getVercelInstallParams(request);
    let redirectUrl = rootPath();

    if (vercelParams) {
      const params = new URLSearchParams({
        code: vercelParams.code,
        configurationId: vercelParams.configurationId,
        integration: "vercel",
      });
      if (vercelParams.next) {
        params.set("next", vercelParams.next);
      }
      redirectUrl = `/orgs/new?${params.toString()}`;
    }

    return redirectWithSuccessMessage(redirectUrl, request, "Your details have been updated.");
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

const HandIcon = forwardRef<HTMLDivElement, {}>(({}, ref) => {
  return (
    <div ref={ref}>
      <HandRaisedIcon className="h-7 w-7 text-amber-400" />
    </div>
  );
});
const MotionHand = motion(HandIcon);

export default function Page() {
  const user = useUser();
  const lastSubmission = useActionData();
  const [enteredEmail, setEnteredEmail] = useState<string>(user.email ?? "");
  const { isManagedCloud } = useFeatures();
  const [selectedReferralSource, setSelectedReferralSource] = useState<string | undefined>();
  const [selectedRole, setSelectedRole] = useState<string>("");

  const [shuffledReferralSources, setShuffledReferralSources] = useState<string[]>([
    ...referralSourceOptions,
  ]);
  const [shuffledRoles, setShuffledRoles] = useState<string[]>([...roleOptions]);

  useEffect(() => {
    const nonOtherReferral = referralSourceOptions.filter((r) => r !== "Other");
    setShuffledReferralSources([...shuffleArray(nonOtherReferral), "Other"]);

    const nonOtherRoles = roleOptions.filter((r) => r !== "Other");
    setShuffledRoles([...shuffleArray(nonOtherRoles), "Other"]);
  }, []);

  const [form, { name, email, confirmEmail }] = useForm({
    id: "confirm-basic-details",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: createSchema() });
    },
    shouldRevalidate: "onSubmit",
  });

  const shouldShowConfirm = user.email !== enteredEmail || user.email === "";

  return (
    <AppContainer className="bg-charcoal-900">
      <BackgroundWrapper>
        <MainCenteredContainer className="max-w-[29rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
          <Form method="post" {...form.props}>
            <FormTitle
              title="Welcome to Trigger.dev"
              LeadingIcon={
                <MotionHand
                  style={{
                    originY: 0.75,
                  }}
                  initial={{
                    rotate: 0,
                  }}
                  animate={{
                    rotate: [0, -20, 0, 20, 0, -20, 0, 20, 0],
                  }}
                  transition={{
                    delay: 1,
                    duration: 1,
                    repeatDelay: 5,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                />
              }
              description="We just need you to confirm a couple of details."
            />
            <Fieldset>
              <InputGroup>
                <Label htmlFor={name.id}>
                  Full name <span className="text-text-bright">*</span>
                </Label>
                <Input
                  {...conform.input(name, { type: "text" })}
                  defaultValue={user.name ?? ""}
                  placeholder="Your full name"
                  icon={UserIcon}
                  autoFocus
                />
                <FormError id={name.errorId}>{name.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={email.id}>
                  Email <span className="text-text-bright">*</span>
                </Label>
                <Input
                  {...conform.input(email, { type: "email" })}
                  defaultValue={enteredEmail}
                  onChange={(e) => {
                    setEnteredEmail(e.target.value);
                  }}
                  placeholder="Your email address"
                  icon={EnvelopeIcon}
                  spellCheck={false}
                />
                <FormError id={email.errorId}>{email.error}</FormError>
              </InputGroup>

              {shouldShowConfirm ? (
                <InputGroup>
                  <Label htmlFor={confirmEmail.id}>Confirm email</Label>
                  <Input
                    {...conform.input(confirmEmail, { type: "email" })}
                    placeholder="Your email, again"
                    icon={EnvelopeIcon}
                    spellCheck={false}
                  />
                  <FormError id={confirmEmail.errorId}>{confirmEmail.error}</FormError>
                </InputGroup>
              ) : (
                <>
                  <input {...conform.input(confirmEmail, { type: "hidden" })} value={user.email} />
                </>
              )}

              {isManagedCloud && (
                <>
                  <div className="border-t border-charcoal-700" />
                  <InputGroup>
                    <Label className="mb-0.5">How did you hear about us?</Label>
                    <input
                      type="hidden"
                      name="referralSource"
                      value={selectedReferralSource ?? ""}
                    />
                    <RadioGroup
                      value={selectedReferralSource}
                      onValueChange={setSelectedReferralSource}
                      className="flex flex-wrap gap-2"
                    >
                      {shuffledReferralSources.map((option) => (
                        <RadioGroupItem
                          key={option}
                          id={`referral-${option}`}
                          label={option}
                          value={option}
                          variant="button/small"
                        />
                      ))}
                    </RadioGroup>
                    {selectedReferralSource === "Other" && (
                      <div className="mt-2">
                        <Input
                          name="referralSourceOther"
                          type="text"
                          placeholder="What was the source?"
                          spellCheck={false}
                        />
                      </div>
                    )}
                  </InputGroup>

                  <InputGroup className="mt-1">
                    <Label>What role fits you best?</Label>
                    <input type="hidden" name="role" value={selectedRole} />
                    <Select<string, string>
                      value={selectedRole}
                      setValue={setSelectedRole}
                      placeholder="Select an option"
                      variant="secondary/small"
                      dropdownIcon
                      icon={<UserGroupIcon className="mr-1 size-4.5 text-text-dimmed" />}
                      items={shuffledRoles}
                      className="h-8 min-w-0 border-0 bg-charcoal-750 pl-2 text-sm text-text-dimmed ring-charcoal-600 transition hover:bg-charcoal-650 hover:text-text-dimmed hover:ring-1"
                      text={(v) => (v ? <span className="text-text-bright">{v}</span> : undefined)}
                    >
                      {(items) =>
                        items.map((item) => (
                          <SelectItem key={item} value={item}>
                            <span className="text-text-bright">{item}</span>
                          </SelectItem>
                        ))
                      }
                    </Select>
                    {selectedRole === "Other" && (
                      <div>
                        <Input
                          name="roleOther"
                          type="text"
                          placeholder="What's your role?"
                          spellCheck={false}
                        />
                      </div>
                    )}
                  </InputGroup>
                </>
              )}

              <FormButtons
                confirmButton={
                  <Button type="submit" variant={"primary/small"} TrailingIcon={ArrowRightIcon}>
                    Continue
                  </Button>
                }
              />
            </Fieldset>
          </Form>
        </MainCenteredContainer>
      </BackgroundWrapper>
    </AppContainer>
  );
}
