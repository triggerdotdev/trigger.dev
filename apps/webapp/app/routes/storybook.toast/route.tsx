import { Toaster, toast } from "sonner";
import { Button } from "~/components/primitives/Buttons";
import { ToastUI } from "~/components/primitives/Toast";

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-4 p-4">
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

      <Toaster />
    </div>
  );
}
