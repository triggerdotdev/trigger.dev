/**
 * @fileoverview Prevent importing from `@trigger.dev/core` directly
 * @author
 */
"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const rule = require("../../../lib/rules/no-trigger-core-import"),
  RuleTester = require("eslint").RuleTester;

//------------------------------------------------------------------------------
// Tests
//------------------------------------------------------------------------------

const ruleTester = new RuleTester({
  parserOptions: {
    sourceType: "module",
    ecmaVersion: 2020,
  },
});
ruleTester.run("no-trigger-core-import", rule, {
  valid: [
    {
      code: `import { conditionallyImportPacket, parsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";`,
    },
  ],

  invalid: [
    {
      code: `import { parsePacket } from '@trigger.dev/core/v3';`,
      output: `import { parsePacket } from '@trigger.dev/core/v3/utils/ioSerialization';`,
      errors: [
        {
          messageId: "noTriggerCoreImportFixable",
        },
      ],
    },
    {
      code: `import { CreateBackgroundWorkerRequestBody, TaskResource } from '@trigger.dev/core/v3';`,
      output: `import { CreateBackgroundWorkerRequestBody } from '@trigger.dev/core/v3/schemas';
import { TaskResource } from '@trigger.dev/core/v3/schemas';`,
      errors: [
        {
          messageId: "noTriggerCoreImportFixable",
        },
      ],
    },
    {
      code: `import { CreateBackgroundWorkerRequestBody, stringifyIO } from '@trigger.dev/core/v3';`,
      output: `import { CreateBackgroundWorkerRequestBody } from '@trigger.dev/core/v3/schemas';
import { stringifyIO } from '@trigger.dev/core/v3/utils/ioSerialization';`,
      errors: [
        {
          messageId: "noTriggerCoreImportFixable",
        },
      ],
    },
    {
      code: `import {
  isExceptionSpanEvent,
 ExceptionEventProperties,
 SpanEvent as OtelSpanEvent,
} from "@trigger.dev/core/v3";`,
      output: `import { isExceptionSpanEvent } from '@trigger.dev/core/v3/schemas';
import { ExceptionEventProperties } from '@trigger.dev/core/v3/schemas';
import { SpanEvent as OtelSpanEvent } from '@trigger.dev/core/v3/schemas';`,
      errors: [
        {
          messageId: "noTriggerCoreImportFixable",
        },
      ],
    },
  ],
});
