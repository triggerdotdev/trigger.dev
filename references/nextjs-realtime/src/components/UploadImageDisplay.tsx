"use client";

import { useState } from "react";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { LoaderPinwheel } from "lucide-react";

type PendingGridImage = {
  status: "pending";
  src?: undefined;
  caption?: undefined;
  message: string;
};

type CompletedGridImage = {
  status: "completed";
  src: string;
  caption: string;
  message: string;
};

type GridImage = PendingGridImage | CompletedGridImage;

export default function ImageDisplay({
  uploadedImage,
  uploadedCaption,
  gridImages = [],
}: {
  uploadedImage: string;
  uploadedCaption: string;
  gridImages: GridImage[];
}) {
  const [isUploadedImageLoaded, setIsUploadedImageLoaded] = useState(false);

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Main uploaded image */}
      <div className="mb-12">
        <div className="relative w-full max-w-3xl mx-auto aspect-video">
          <Image
            src={uploadedImage}
            alt={uploadedCaption}
            fill
            className={`object-cover rounded-lg shadow-lg transition-opacity duration-300 ${
              isUploadedImageLoaded ? "opacity-100" : "opacity-0"
            }`}
            onLoadingComplete={() => setIsUploadedImageLoaded(true)}
          />
        </div>
        <p className="text-center mt-3 text-sm font-medium text-primary">{uploadedCaption}</p>
      </div>

      {/* Grid of smaller images */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-6">
        {gridImages.map((image, index) => (
          <Card key={index} className="overflow-hidden">
            <CardContent className="p-0">
              <div
                className={`relative aspect-square ${
                  image.status === "pending" ? "bg-gray-100" : ""
                }`}
              >
                {image.status === "completed" ? (
                  <Image src={image.src} alt={image.caption} fill className="object-cover" />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center p-4">
                    <LoaderPinwheel className="w-8 h-8 animate-spin text-primary mb-2" />
                    <p className="text-xs text-center text-primary">{image.message}</p>
                  </div>
                )}
              </div>
              {image.status === "completed" && (
                <p className="p-2 text-center text-xs text-primary">{image.caption}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
