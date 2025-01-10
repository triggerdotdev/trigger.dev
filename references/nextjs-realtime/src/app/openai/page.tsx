import BatchSubmissionForm from "@/components/BatchSubmissionForm";
import { auth } from "@trigger.dev/sdk/v3";

export default async function Page() {
  const accessToken = await auth.createTriggerPublicToken("openai-batch");

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4 space-y-8">
      <BatchSubmissionForm accessToken={accessToken} />
    </div>
  );
}
