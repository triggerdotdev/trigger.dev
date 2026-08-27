import { ComponentNames } from "../storybook/StoryKit";
import { toast } from "sonner";
import { Button } from "~/components/primitives/Buttons";
import { ToastUI } from "~/components/primitives/Toast";

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-4 p-4">
      <div className="px-4 pt-4">
        <ComponentNames names={["Toast.tsx"]} />
      </div>
      <ToastUI variant="success" message="Success UI" t="-" />
      <ToastUI
        variant="success"
        message="This is a long success message that wraps over multiple lines so we can test the UI."
        t="-"
      />
      <ToastUI variant="error" message="Error UI" t="-" />
      <ToastUI
        variant="error"
        message="This is a long error message that wraps over multiple lines so we can test the UI."
        t="-"
      />
      <ToastUI variant="agent" message="Agent info UI" t="-" />
      <ToastUI
        variant="agent"
        title="Watch update"
        message="Error error_c4b4a797 happened again — 1 new occurrence since the watch started."
        t="-"
        actionNode={
          <Button variant="secondary/small" className="my-2 self-start">
            Open chat
          </Button>
        }
      />
      <br />
      <Button
        variant="primary/medium"
        onClick={() =>
          toast.custom((t) => <ToastUI variant="success" message="Success" t={t as string} />, {
            duration: Infinity, // Prevents auto-dismissal for demo purposes
          })
        }
      >
        Trigger success toast
      </Button>
      <Button
        variant="danger/medium"
        onClick={() =>
          toast.custom((t) => <ToastUI variant="error" message="Error" t={t as string} />, {
            duration: Infinity,
          })
        }
      >
        Trigger error toast
      </Button>
      <Button
        variant="secondary/medium"
        onClick={() =>
          toast.custom(
            (t) => (
              <ToastUI
                variant="agent"
                title="Watch update"
                message="Error error_c4b4a797 happened again — 1 new occurrence since the watch started."
                t={t as string}
                actionNode={
                  <Button
                    variant="secondary/small"
                    className="my-2 self-start"
                    onClick={() => toast.dismiss(t as string)}
                  >
                    Open chat
                  </Button>
                }
              />
            ),
            { duration: Infinity }
          )
        }
      >
        Trigger agent toast
      </Button>
    </div>
  );
}
