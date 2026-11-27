"use client";

import dynamic from "next/dynamic";

// The playground's client code loads only on API pages, not with every page's shared chunks.
export const APIPage = dynamic(() => import("./api-page").then((m) => m.APIPage));
