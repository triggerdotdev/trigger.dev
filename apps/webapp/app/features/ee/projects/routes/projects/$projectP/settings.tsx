import { TrashIcon } from "@heroicons/react/24/outline";
import { Form, useTransition } from "@remix-run/react";
import { ActionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedActionData } from "remix-typedjson";
import { z } from "zod";
import { CopyTextButton, CopyTextPanel } from "~/components/CopyTextButton";
import { Panel } from "~/components/layout/Panel";
import { PanelWarning } from "~/components/layout/PanelInfo";
import { DangerButton, PrimaryButton } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Select } from "~/components/primitives/Select";
import { Body } from "~/components/primitives/text/Body";
import { Header1 } from "~/components/primitives/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { useLiveEnvironment } from "~/hooks/useEnvironments";
import {
  setRequestSuccessMessage,
  setToastMessageCookie,
} from "~/models/message.server";
import { useCurrentProject } from "../$projectP";
import { DisableProjectService } from "../../../services/disableProject.server";
import { UpdateProjectSettings } from "../../../services/updateProjectSettings.server";

export async function action({ params, request }: ActionArgs) {
  const { projectP, organizationSlug } = z
    .object({ projectP: z.string(), organizationSlug: z.string() })
    .parse(params);

  const formPayload = await request.formData();

  const action = formPayload.get("action");

  if (action === "destroy") {
    const service = new DisableProjectService();
    const project = await service.call(projectP);

    const session = await setRequestSuccessMessage(
      request,
      `Repository ${project.name} has been removed and will no longer be deployed.`
    );

    return redirect(`/orgs/${organizationSlug}/projects`, {
      headers: await setToastMessageCookie(session),
    });
  }

  const formEntries = Object.fromEntries(formPayload);

  // formEntries has the following shape:
  // {
  //   "envVars[GITHUB_REPOSITORY]": "triggerdotdev/trigger.dev",
  //   "envVars[OTHER_ENV_VAR]": "bar",
  //   "autoDeploy": "yes",
  //   "buildCommand": "npm start"
  // }

  // So we need to transform it into:
  // {
  //   envVars: {
  //     GITHUB_REPOSITORY: "triggerdotdev/trigger.dev",
  //     OTHER_ENV_VAR: "bar"
  //   },
  //   autoDeploy: "yes",
  //   buildCommand: "npm start"
  // }

  const envVars = Object.entries(formEntries)
    .filter(([key]) => key.startsWith("envVars["))
    .reduce((acc, [key, value]) => {
      const envVarKey = key.replace("envVars[", "").replace("]", "");

      return { ...acc, [envVarKey]: value };
    }, {}) as Record<string, string>;

  const service = new UpdateProjectSettings();

  console.log(formEntries, envVars);

  const validation = service.validate(formEntries, envVars);

  switch (validation.type) {
    case "payloadError": {
      return typedjson(
        { type: "validationError" as const, errors: validation.errors },
        { status: 422 }
      );
    }
    case "success": {
      const isDeploying = await service.call(projectP, validation.data);

      const session = await setRequestSuccessMessage(
        request,
        isDeploying
          ? "Settings updated. Deploying your repo now..."
          : "Settings updated. They'll take effect on the next deployment."
      );

      if (isDeploying) {
        return redirect(`/orgs/${organizationSlug}/projects/${projectP}`, {
          headers: await setToastMessageCookie(session),
        });
      }

      return typedjson(
        { type: "success" as const },
        { status: 200, headers: await setToastMessageCookie(session) }
      );
    }
  }
}

export default function ProjectSettingsPage() {
  const { project, needsEnvVars, envVars } = useCurrentProject();
  const env = useLiveEnvironment();

  const actionData = useTypedActionData<typeof action>();
  const transition = useTransition();

  const isSubmittingOrLoading =
    (transition.state === "submitting" &&
      transition.type === "actionSubmission" &&
      transition.submission.method === "POST") ||
    (transition.state === "loading" && transition.type === "actionRedirect");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between">
        <Header1 className="mb-6">Settings</Header1>
        <Form
          method="delete"
          reloadDocument
          onSubmit={(e) =>
            !confirm(
              "Are you sure you want to remove this repository? This action cannot be undone. Any running deployments will be stopped."
            ) && e.preventDefault()
          }
        >
          <DangerButton name="action" value="destroy" type="submit">
            <TrashIcon className="-ml-1.5 h-5 w-5" />
            Remove repository
          </DangerButton>
        </Form>
      </div>

      {needsEnvVars && (
        <PanelWarning
          message="Deployments are disabled until you add the required environment variables."
          className="mb-6"
        ></PanelWarning>
      )}
      <SubTitle>Environment variables</SubTitle>
      <Panel className="mb-6 py-4 px-4">
        {env && (
          <div className="grid w-full grid-cols-[1fr_auto] items-end gap-2">
            <div className="w-full">
              <Body size="small" className="mb-1 text-slate-400">
                TRIGGER_API_KEY
              </Body>
              <Input
                id="TRIGGER_API_KEY"
                spellCheck={false}
                disabled={true}
                value={env.apiKey}
                className="w-full"
              />
            </div>
            <CopyTextButton value={env.apiKey} className="mb-0.5" />
          </div>
        )}
      </Panel>
      <SubTitle>Configure build and deploy settings</SubTitle>
      <Panel className="px-4 py-4">
        <Form method="post">
          <>
            {envVars.length > 0 && (
              <div className="mb-3 grid grid-cols-1 gap-4">
                {envVars.map((envVar) => (
                  <InputGroup key={envVar.key}>
                    <Label htmlFor={envVar.key}>{envVar.key}</Label>

                    <Input
                      id={envVar.key}
                      name={`envVars[${envVar.key}]`}
                      spellCheck={false}
                      placeholder="Enter a value"
                      className=""
                      disabled={isSubmittingOrLoading}
                      defaultValue={envVar.value}
                    />

                    {!isSubmittingOrLoading &&
                      actionData?.type === "validationError" && (
                        <FormError
                          errors={actionData.errors}
                          path={[envVar.key]}
                        />
                      )}
                  </InputGroup>
                ))}
              </div>
            )}
          </>

          <div className="mb-3 grid grid-cols-2 items-start gap-4">
            <InputGroup>
              <Label htmlFor="autoDeploy">Auto deploy</Label>
              <Select
                disabled={isSubmittingOrLoading}
                name="autoDeploy"
                required
                defaultValue={project.autoDeploy ? "yes" : "no"}
              >
                <option value="yes">
                  Yes, automatically deploy on every push
                </option>

                <option value="no">No, I'll handle my deploys manually</option>
              </Select>
            </InputGroup>

            <InputGroup>
              <Label htmlFor="branch">Repo branch</Label>
              <Input
                id="branch"
                name="branch"
                spellCheck={false}
                placeholder="main"
                className=""
                disabled={isSubmittingOrLoading}
                defaultValue={project.branch}
              />

              {!isSubmittingOrLoading &&
                actionData?.type === "validationError" && (
                  <FormError errors={actionData.errors} path={["branch"]} />
                )}
            </InputGroup>
          </div>
          <div className="mb-3 grid grid-cols-2 items-start gap-4">
            <InputGroup>
              <Label htmlFor="buildCommand">Build command</Label>
              <Input
                id="buildCommand"
                name="buildCommand"
                spellCheck={false}
                placeholder="npm install"
                className=""
                disabled={isSubmittingOrLoading}
                defaultValue={project.buildCommand}
              />

              {!isSubmittingOrLoading &&
                actionData?.type === "validationError" && (
                  <FormError
                    errors={actionData.errors}
                    path={["buildCommand"]}
                  />
                )}
            </InputGroup>

            <InputGroup>
              <Label htmlFor="startCommand">Start command</Label>
              <Input
                id="startCommand"
                name="startCommand"
                spellCheck={false}
                placeholder="npm install"
                className=""
                disabled={isSubmittingOrLoading}
                defaultValue={project.startCommand}
              />

              {!isSubmittingOrLoading &&
                actionData?.type === "validationError" && (
                  <FormError
                    errors={actionData.errors}
                    path={["startCommand"]}
                  />
                )}
            </InputGroup>
          </div>
          <div className="flex justify-end">
            {isSubmittingOrLoading ? (
              <PrimaryButton disabled>Saving...</PrimaryButton>
            ) : (
              <PrimaryButton type="submit" name="action" value="save">
                Save
              </PrimaryButton>
            )}
          </div>
        </Form>
      </Panel>
    </div>
  );
}
