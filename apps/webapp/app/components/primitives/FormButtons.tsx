export function FormButtons({
  cancelButton,
  confirmButton,
}: {
  cancelButton?: React.ReactNode;
  confirmButton: React.ReactNode;
}) {
  return (
    <div className="flex w-full items-center justify-between">
      {cancelButton ? cancelButton : <div />} {confirmButton}
    </div>
  );
}
