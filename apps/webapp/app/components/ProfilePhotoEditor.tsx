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
import { Spinner } from "./primitives/Spinner";

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

function isInlineImage(url: string) {
  return url.startsWith("data:");
}

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
  // Ref for the async load guard, state for rendering.
  const hasPickedRef = useRef(false);
  const [hasPicked, setHasPicked] = useState(false);
  const isInline = currentAvatarUrl !== undefined && isInlineImage(currentAvatarUrl);
  const [imageSrc, setImageSrc] = useState(isInline ? currentAvatarUrl : undefined);
  const [crop, setCrop] = useState<Point>(CENTER);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [croppedArea, setCroppedArea] = useState<Area>();
  const [error, setError] = useState<string>();
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isLoadingCurrent, setIsLoadingCurrent] = useState(
    currentAvatarUrl !== undefined && !isInline
  );

  useEffect(() => {
    if (!imageSrc) return;
    return () => URL.revokeObjectURL(imageSrc);
  }, [imageSrc]);

  // The cropper exports through a canvas, so the current photo has to come in as
  // same-origin bytes rather than a remote URL. A missing one is just no photo.
  useEffect(() => {
    if (currentAvatarUrl === undefined || isInlineImage(currentAvatarUrl)) return;

    let cancelled = false;

    async function loadCurrentAvatar(url: string) {
      try {
        const response = await fetch(`${url}?raw`);
        if (!response.ok) return;

        const blob = await response.blob();
        if (cancelled || hasPickedRef.current) return;
        // An expired session redirects to the login HTML, which fetch follows
        // with response.ok still true and would leave a blank cropper.
        if (response.redirected || !ACCEPTED_TYPES.includes(blob.type)) return;

        setImageSrc(URL.createObjectURL(blob));
      } catch {
        // Leaves the empty state in place.
      } finally {
        if (!cancelled) {
          setIsLoadingCurrent(false);
        }
      }
    }

    void loadCurrentAvatar(currentAvatarUrl);

    return () => {
      cancelled = true;
    };
  }, [currentAvatarUrl]);

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

    hasPickedRef.current = true;
    setHasPicked(true);
    setCrop(CENTER);
    setZoom(MIN_ZOOM);
    setCroppedArea(undefined);
    setError(undefined);
    setIsLoadingCurrent(false);
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
        ) : isLoadingCurrent ? (
          <div className="flex h-64 w-full items-center justify-center rounded-md border border-dashed border-grid-bright">
            <Spinner />
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
        <div className="flex items-center gap-2">
          <Button
            variant="tertiary/medium"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSaving}
          >
            {imageSrc ? "Choose another" : "Choose image"}
          </Button>
          {/* Only while the existing photo is showing, or it would discard a pending crop. */}
          {onRemove && imageSrc && !hasPicked && (
            <Button variant="danger/medium" onClick={onRemove} disabled={isSaving}>
              Remove
            </Button>
          )}
        </div>
        <Button
          variant="primary/medium"
          onClick={save}
          disabled={!croppedArea}
          isLoading={isSaving}
        >
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}
