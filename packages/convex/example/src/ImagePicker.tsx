import { useEffect, useRef } from "react";
import { SAMPLES } from "../shared/catalog";
import type { SampleId } from "../shared/types";

export function ImagePicker({
  open,
  selected,
  onChoose,
  onClose,
}: {
  open: boolean;
  selected: SampleId;
  onChoose: (sample: SampleId) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="image-picker"
      aria-labelledby="image-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      closedby="any"
      onClose={onClose}
    >
      <div className="dialog-heading">
        <h2 id="image-picker-title">Choose an image</h2>
        <button
          type="button"
          className="text-button"
          onClick={onClose}
          aria-label="Close image picker"
        >
          Close
        </button>
      </div>
      {open && (
        <div className="image-options">
          {SAMPLES.map((sample) => (
            <button
              type="button"
              key={sample.id}
              aria-pressed={selected === sample.id}
              onClick={() => {
                onChoose(sample.id);
                onClose();
              }}
            >
              <img src={sample.file} alt="" loading="lazy" width={320} height={220} />
              <span>{sample.name}</span>
            </button>
          ))}
        </div>
      )}
    </dialog>
  );
}
