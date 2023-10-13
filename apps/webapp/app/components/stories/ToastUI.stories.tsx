import type { Meta, StoryObj } from "@storybook/react";
import { Toaster, toast } from "sonner";
import { ToastUI } from "../primitives/Toast";
import { Button } from "../primitives/Buttons";

const meta: Meta = {
  title: "Primitives/Toast",
};

export default meta;

type Story = StoryObj<typeof Collection>;

export const Toasts: Story = {
  render: () => <Collection />,
};

function Collection() {
  return (
    <div className="flex flex-col items-start gap-y-4 p-4">
      <ToastUI variant="success" message="Success UI" t="-" />
      <ToastUI variant="error" message="Error UI" t="-" />
      <br />
      <Button
        variant="primary/large"
        onClick={() =>
          toast.custom((t) => <ToastUI variant="success" message="Success" t={t as string} />, {
            duration: Infinity, // Prevents auto-dismissal for demo purposes
          })
        }
      >
        Success
      </Button>
      <Button
        variant="primary/large"
        onClick={() =>
          toast.custom((t) => <ToastUI variant="error" message="Error" t={t as string} />, {
            duration: Infinity,
          })
        }
      >
        Error
      </Button>
      <Toaster />
    </div>
  );
}
