"use client";

import React from "react";
import { createContextAndHook } from "./utils/createContextAndHook.js";
import type { ApiClientConfiguration } from "@trigger.dev/core/v3";

const [TriggerAuthContext, useTriggerAuthContext] =
  createContextAndHook<ApiClientConfiguration>("TriggerAuthContext");

export { TriggerAuthContext, useTriggerAuthContext };
