import type { OutputColumnMetadata } from "@internal/clickhouse";
import { toast } from "sonner";
import { ToastUI } from "~/components/primitives/Toast";
import type { RenderIcon } from "~/components/primitives/Icon";
import { rowsToCSV, rowsToJSON } from "~/utils/dataExport";

export type AgentBlockTool = {
  icon: RenderIcon;
  title: string;
  onClick: () => void;
  disabled?: boolean;
};

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(
    () => {
      toast.custom((t) => <ToastUI variant="success" message="Copied" t={t as string} />);
    },
    () => {
      toast.custom((t) => <ToastUI variant="error" message="Couldn't copy" t={t as string} />);
    }
  );
}

export function copyRowsAsJSON(rows: Record<string, unknown>[]) {
  copyToClipboard(rowsToJSON(rows));
}

export function copyRowsAsCSV(rows: Record<string, unknown>[], columns: OutputColumnMetadata[]) {
  copyToClipboard(rowsToCSV(rows, columns));
}

export function copyText(text: string) {
  copyToClipboard(text);
}
