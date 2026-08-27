import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef, useState } from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
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
  isSaving?: boolean;
};

export function ProfilePhotoEditor({
  open,
  onOpenChange,
  onSave,
  isSaving = false,
}: ProfilePhotoEditorProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Profile picture</DialogTitle>
        </DialogHeader>
        {/* Radix unmounts the content when closed, so the crop state resets with it. */}
        <Editor onSave={onSave} isSaving={isSaving} />
      </DialogContent>
    </Dialog>
  );
}

function Editor({ onSave, isSaving }: Pick<ProfilePhotoEditorProps, "onSave" | "isSaving">) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageSrc, setImageSrc] = useState<string>();
  const [crop, setCrop] = useState<Point>(CENTER);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [croppedArea, setCroppedArea] = useState<Area>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!imageSrc) return;
    return () => URL.revokeObjectURL(imageSrc);
  }, [imageSrc]);

  function selectFile(file: File | undefined) {
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
    <>
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
            <div className="relative h-64 w-full overflow-hidden rounded-md bg-charcoal-900">
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
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-64 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-grid-bright text-text-dimmed transition hover:border-text-dimmed hover:text-text-bright"
          >
            <Paragraph variant="small">Choose an image</Paragraph>
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
          {imageSrc ? "Choose another" : "Choose image"}
        </Button>
        <Button
          variant="primary/medium"
          onClick={save}
          disabled={!croppedArea}
          isLoading={isSaving}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
