export function FormButtons({
  cancelButton,
  confirmButton,
}: {
  cancelButton?: React.ReactNode;
  confirmButton: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      {cancelButton ? cancelButton : <div />} {confirmButton}
    </div>
  );
}
