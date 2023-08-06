import { ExclamationCircleIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { AnimatePresence, motion } from "framer-motion";
import toast, { Toaster, resolveValue, useToasterStore } from "react-hot-toast";
import { useTypedLoaderData } from "remix-typedjson";
import { loader } from "~/root";
import { useEffect } from "react";

const defaultToastDuration = 5000;
const permanentToastDuration = 60 * 60 * 24 * 1000;

export function Toast() {
  const { toastMessage } = useTypedLoaderData<typeof loader>();

  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const { message, type, options } = toastMessage;

    switch (type) {
      case "success":
        toast.success(message, {
          duration: options.ephemeral ? defaultToastDuration : permanentToastDuration,
        });
        break;
      case "error":
        toast.error(message, {
          duration: options.ephemeral ? defaultToastDuration : permanentToastDuration,
        });
        break;
      default:
        throw new Error(`${type} is not handled`);
    }
  }, [toastMessage]);

  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        success: {
          icon: <CheckCircleIcon className="h-6 w-6 text-green-600" />,
        },
        error: {
          icon: <ExclamationCircleIcon className="h-6 w-6 text-rose-600" />,
        },
      }}
    >
      {(t) => (
        <AnimatePresence>
          <motion.div
            className="flex gap-2 rounded-lg border border-slate-750 bg-no-repeat p-4 text-bright shadow-md"
            style={{
              opacity: t.visible ? 1 : 0,
              background:
                "radial-gradient(at top, hsla(271, 91%, 65%, 0.18), hsla(221, 83%, 53%, 0.18)) hsla(221, 83%, 53%, 0.18)",
            }}
            initial={{ opacity: 0, y: 100 }}
            animate={t.visible ? "visible" : "hidden"}
            variants={{
              hidden: {
                opacity: 0,
                y: 0,
                transition: {
                  duration: 0.15,
                  ease: "easeInOut",
                },
              },
              visible: {
                opacity: 1,
                y: 0,
                transition: {
                  duration: 0.3,
                  ease: "easeInOut",
                },
              },
            }}
          >
            {t.icon}
            {resolveValue(t.message, t)}
            <button className="p-1" onClick={() => toast.dismiss(t.id)}>
              <XMarkIcon className="h-4 w-4 text-bright" />
            </button>
          </motion.div>
        </AnimatePresence>
      )}
    </Toaster>
  );
}
