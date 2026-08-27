import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef, useState } from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import { cn } from "~/utils/cn";
import { Button } from "./primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./primitives/Dialog";
import { Paragraph } from "./primitives/Paragraph";
import { Slider } from "./primitives/Slider";

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const OUTPUT_SIZE = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.01;
const CENTER: Point = { x: 0, y: 0 };

async function cropImageToBlob(imageSrc: string, area: Area): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a canvas to crop the image");
  }

  context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not crop the image"));
      }
    }, "image/png");
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Could not load the image")));
    image.src = src;
  });
}

type ProfilePhotoEditorProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (blob: Blob) => void;
  currentAvatarUrl?: string;
  onRemove?: () => void;
  isSaving?: boolean;
};

export function ProfilePhotoEditor({
  open,
  onOpenChange,
  isSaving = false,
  ...editorProps
}: ProfilePhotoEditorProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Profile picture</DialogTitle>
        </DialogHeader>
        {/* Radix unmounts the content when closed, so the crop state resets with it. */}
        <Editor {...editorProps} isSaving={isSaving} />
      </DialogContent>
    </Dialog>
  );
}

type EditorProps = Omit<ProfilePhotoEditorProps, "open" | "onOpenChange">;

function Editor({ onSave, currentAvatarUrl, onRemove, isSaving }: EditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageSrc, setImageSrc] = useState<string>();
  const [crop, setCrop] = useState<Point>(CENTER);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [croppedArea, setCroppedArea] = useState<Area>();
  const [error, setError] = useState<string>();
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  useEffect(() => {
    if (!imageSrc) return;
    return () => URL.revokeObjectURL(imageSrc);
  }, [imageSrc]);

  // A drop landing outside our own handlers would navigate the tab to the file
  // and lose the crop. Editor only exists while the dialog is open.
  useEffect(() => {
    const suppress = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", suppress);
    window.addEventListener("drop", suppress);
    return () => {
      window.removeEventListener("dragover", suppress);
      window.removeEventListener("drop", suppress);
    };
  }, []);

  function selectFile(file: File | undefined) {
    if (isSaving) return;
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError("Choose a PNG, JPEG or WebP image.");
      return;
    }

    setCrop(CENTER);
    setZoom(MIN_ZOOM);
    setCroppedArea(undefined);
    setError(undefined);
    setImageSrc(URL.createObjectURL(file));
  }

  async function save() {
    if (!imageSrc || !croppedArea) return;

    try {
      onSave(await cropImageToBlob(imageSrc, croppedArea));
    } catch {
      setError("Could not crop that image. Try another one.");
    }
  }

  return (
    <div
      className="flex flex-col gap-4"
      onDragOver={(event) => {
        event.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={(event) => {
        // Moving between children fires dragleave too, so ignore inside targets.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setIsDraggingOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDraggingOver(false);
        selectFile(event.dataTransfer.files[0]);
      }}
    >
      <div className="flex flex-col gap-4 pt-4">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            selectFile(event.target.files?.[0]);
            // Or re-picking the same file after an error fires no change event.
            event.target.value = "";
          }}
        />
        {imageSrc ? (
          <>
            <div
              className={cn(
                "relative h-64 w-full overflow-hidden rounded-md bg-charcoal-900 ring-1",
                isDraggingOver ? "ring-primary" : "ring-transparent"
              )}
            >
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_, areaPixels) => setCroppedArea(areaPixels)}
              />
            </div>
            <Slider
              variant="settings"
              aria-label="Zoom"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={ZOOM_STEP}
              value={[zoom]}
              onValueChange={([value]) => setZoom(value)}
              disabled={isSaving}
              LeadingIcon={MagnifyingGlassMinusIcon}
              TrailingIcon={MagnifyingGlassPlusIcon}
            />
          </>
        ) : currentAvatarUrl ? (
          <div
            className={cn(
              "flex h-64 w-full items-center justify-center rounded-md bg-charcoal-900 ring-1",
              isDraggingOver ? "ring-primary" : "ring-transparent"
            )}
          >
            {/* Fills the box like the cropper's circle, so switching doesn't jump. */}
            <img
              src={currentAvatarUrl}
              alt=""
              className="aspect-square h-full rounded-full object-cover"
              draggable={false}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "flex h-64 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-text-dimmed transition hover:border-text-dimmed hover:text-text-bright",
              isDraggingOver ? "border-primary" : "border-grid-bright"
            )}
          >
            <Paragraph variant="small">Choose or drop an image</Paragraph>
            <Paragraph variant="extra-small">PNG, JPEG or WebP</Paragraph>
          </button>
        )}
        {error && (
          <Paragraph variant="small" className="text-error">
            {error}
          </Paragraph>
        )}
      </div>
      <DialogFooter>
        <Button
          variant="tertiary/medium"
          onClick={() => fileInputRef.current?.click()}
          disabled={isSaving}
        >
          {imageSrc || currentAvatarUrl ? "Choose another" : "Choose image"}
        </Button>
        {/* Nothing to save until a new file is cropped, so the saved photo offers
            Remove in the same slot instead. */}
        {imageSrc ? (
          <Button
            variant="primary/medium"
            onClick={save}
            disabled={!croppedArea}
            isLoading={isSaving}
          >
            Save
          </Button>
        ) : (
          onRemove &&
          currentAvatarUrl && (
            <Button variant="danger/medium" onClick={onRemove} disabled={isSaving}>
              Remove
            </Button>
          )
        )}
      </DialogFooter>
    </div>
  );
}
