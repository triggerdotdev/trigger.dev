import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  enrichCreatableEvents,
  setLlmPricingRegistry,
} from "../app/v3/utils/enrichCreatableEvents.server.js";
import {
  RuntimeEnvironmentType,
  TaskEventKind,
  TaskEventLevel,
  TaskEventStatus,
} from "@trigger.dev/database";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";

describe("OTLPExporter", () => {
  describe("enrichCreatableEvents", () => {
    it("should enrich creatable events that have template strings in the message", () => {
      const events = [
        {
          traceId: "4e184936f7a0ef5af428a29b4d47da9d",
          spanId: "1be4ebd8c78e43e9",
          parentId: "f1a6d77fd5872bbe",
          message: "Responses API with {gen_ai.request.model!r}",
          isPartial: false,
          isError: false,
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1743103947959190000),
          links: [],
          events: [],
          duration: 2931702000,
          properties: {
            "code.filepath": "src/trigger/python/agent.py",
            "code.lineno": 171,
            model_settings:
              '{"temperature":null,"top_p":null,"frequency_penalty":null,"presence_penalty":null,"tool_choice":null,"parallel_tool_calls":false,"truncation":null,"max_tokens":null}',
            "gen_ai.request.model": "gpt-4o",
            "logfire.msg_template": "Responses API with {gen_ai.request.model!r}",
            "logfire.span_type": "span",
            response_id: "resp_67e5a7cd046c8192b3bfb6c863057f60003e29fb266e3c7b",
            "gen_ai.system": "openai",
            "gen_ai.response.model": "gpt-4o-2024-08-06",
            response:
              '{"id":"resp_67e5a7cd046c8192b3bfb6c863057f60003e29fb266e3c7b","created_at":1743103949.0,"error":null,"incomplete_details":null,"instructions":"You are an expert at enriching contact information data.\\n    Your task is to use web search to find additional information about a person\\n    based on their basic contact details.\\n\\n    Please find the basic information, company information, and social media information for the person.\\n\\n    The input data is from an unspecified CSV dataset, but most likely a CSV dump from a CRM or other source like Mailchimp, etc.\\n\\n    You\'ll receive the header row and a single row from the dataset to enrich, in their raw form.\\n    \\n    Only include information you are confident about from reliable sources.\\n    Use null for fields where you cannot find reliable information.\\n    ","metadata":{},"model":"gpt-4o-2024-08-06","object":"response","output":[{"arguments":"{\\"input\\":\\"Eric,eric@trigger.dev\\"}","call_id":"call_OPlvy1ubdx75L8AgGIfVTWlW","name":"basic_info_agent","type":"function_call","id":"fc_67e5a7ce1418819281d73995bf0ffcf9003e29fb266e3c7b","status":"completed"}],"parallel_tool_calls":false,"temperature":1.0,"tool_choice":"auto","tools":[{"name":"basic_info_agent","parameters":{"properties":{"input":{"title":"Input","type":"string"}},"required":["input"],"title":"basic_info_agent_args","type":"object","additionalProperties":false},"strict":true,"type":"function","description":"Extract basic information from a person\'s contact details"},{"name":"company_info_agent","parameters":{"properties":{"input":{"title":"Input","type":"string"}},"required":["input"],"title":"company_info_agent_args","type":"object","additionalProperties":false},"strict":true,"type":"function","description":"Extract company information from a person\'s contact details"},{"name":"social_info_agent","parameters":{"properties":{"input":{"title":"Input","type":"string"}},"required":["input"],"title":"social_info_agent_args","type":"object","additionalProperties":false},"strict":true,"type":"function","description":"Extract social media information from a person\'s contact details"}],"top_p":1.0,"max_output_tokens":null,"previous_response_id":null,"reasoning":{"effort":null,"generate_summary":null},"status":"completed","text":{"format":{"schema_":{"$defs":{"BasicInfo":{"properties":{"name":{"description":"The name of the row","title":"Name","type":"string"},"email":{"description":"The email of the row","title":"Email","type":"string"},"firstName":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The first name of the row","title":"Firstname"},"lastName":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The last name of the row","title":"Lastname"},"preferredName":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The preferred name of the row","title":"Preferredname"}},"required":["name","email","firstName","lastName","preferredName"],"title":"BasicInfo","type":"object","additionalProperties":false},"CompanyInfo":{"properties":{"name":{"description":"The name of the company","title":"Name","type":"string"},"industry":{"description":"The industry of the company","title":"Industry","type":"string"}},"required":["name","industry"],"title":"CompanyInfo","type":"object","additionalProperties":false},"SocialInfo":{"properties":{"twitter":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The Twitter username of the person","title":"Twitter"},"linkedin":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The LinkedIn username of the person","title":"Linkedin"},"facebook":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The Facebook username of the person","title":"Facebook"},"instagram":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The Instagram username of the person","title":"Instagram"}},"title":"SocialInfo","type":"object","additionalProperties":false,"required":["twitter","linkedin","facebook","instagram"]}},"properties":{"basicInfo":{"$ref":"#/$defs/BasicInfo"},"companyInfo":{"$ref":"#/$defs/CompanyInfo"},"socialInfo":{"$ref":"#/$defs/SocialInfo"}},"required":["basicInfo","companyInfo","socialInfo"],"title":"RowEnrichmentResult","type":"object","additionalProperties":false},"type":"json_schema","description":null,"name":"final_output","strict":true}},"truncation":"disabled","usage":{"input_tokens":702,"input_tokens_details":{"cached_tokens":0},"output_tokens":22,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":724},"user":null,"store":true}',
            "gen_ai.operation.name": "chat",
            raw_input:
              '[{"content":"\\n        Header row: Name,Email\\n        Row to enrich: Eric,eric@trigger.dev\\n        CSV URL: https://example.com/import.csv\\n        ","role":"user"}]',
            events:
              '[{"event.name":"gen_ai.system.message","content":"You are an expert at enriching contact information data.\\n    Your task is to use web search to find additional information about a person\\n    based on their basic contact details.\\n\\n    Please find the basic information, company information, and social media information for the person.\\n\\n    The input data is from an unspecified CSV dataset, but most likely a CSV dump from a CRM or other source like Mailchimp, etc.\\n\\n    You\'ll receive the header row and a single row from the dataset to enrich, in their raw form.\\n    \\n    Only include information you are confident about from reliable sources.\\n    Use null for fields where you cannot find reliable information.\\n    ","role":"system"},{"event.name":"gen_ai.user.message","content":"\\n        Header row: Name,Email\\n        Row to enrich: Eric,eric@trigger.dev\\n        CSV URL: https://example.com/import.csv\\n        ","role":"user"},{"event.name":"gen_ai.choice","index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_OPlvy1ubdx75L8AgGIfVTWlW","type":"function","function":{"name":"basic_info_agent","arguments":"{\\"input\\":\\"Eric,eric@trigger.dev\\"}"}}]}}]',
            "gen_ai.usage.input_tokens": 702,
            "gen_ai.usage.output_tokens": 22,
            "logfire.msg": "Responses API with 'gpt-4o'",
          },
          payloadType: "application/json",
          metadata: {
            "service.instance.id": "eae3f05bfa924058b1aa79c6decd79fe",
          },
          serviceName: "d3-demo",
          serviceNamespace: "unknown",
          environmentId: "cm8r871mw0002dy8n6ec3y0i2",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
          organizationId: "cm5ohng6o0002dyuzvr0qq4xo",
          projectId: "cm8r871lq0000dy8nhljain0w",
          projectRef: "proj_wkbbtayxrmeyqhankehb",
          runId: "run_cm8rr2zw50000efdyyq0376m5",
          runIsTest: false,
          attemptId: "deprecated",
          taskSlug: "row-agent-runner",
          taskPath: "src/trigger/d3Demo.ts",
          taskExportName: "@deprecated",
          workerId: "unmanaged",
          workerVersion: "20250327.54",
          queueId: "queue_pn4256pg6c2wc9rro3o7i",
          queueName: "task/row-agent-runner",
          batchId: "undefined",
          idempotencyKey: "undefined",
          machinePreset: "small-1x",
          style: {},
          output: {},
          payload: {},
        },
      ];

      const $events = enrichCreatableEvents(events);
      expect($events).toBeDefined();

      const event = $events[0];
      expect(event.message).toBe("Responses API with 'gpt-4o'");
      expect(event.style).toMatchObject({
        icon: "tabler-brand-openai",
      });
    });

    it("should enrich creatable events that have template strings without the !r in the message", () => {
      const events = [
        {
          traceId: "4e184936f7a0ef5af428a29b4d47da9d",
          spanId: "1be4ebd8c78e43e9",
          parentId: "f1a6d77fd5872bbe",
          message: "Responses API with {gen_ai.request.model}",
          isPartial: false,
          isError: false,
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1743103947959190000),
          links: [],
          events: [],
          duration: 2931702000,
          properties: {
            "code.filepath": "src/trigger/python/agent.py",
            "code.lineno": 171,
            model_settings:
              '{"temperature":null,"top_p":null,"frequency_penalty":null,"presence_penalty":null,"tool_choice":null,"parallel_tool_calls":false,"truncation":null,"max_tokens":null}',
            "gen_ai.request.model": "gpt-4o",
            "logfire.msg_template": "Responses API with {gen_ai.request.model}",
            "logfire.span_type": "span",
            response_id: "resp_67e5a7cd046c8192b3bfb6c863057f60003e29fb266e3c7b",
            "gen_ai.system": "openai",
            "gen_ai.response.model": "gpt-4o-2024-08-06",
            response:
              '{"id":"resp_67e5a7cd046c8192b3bfb6c863057f60003e29fb266e3c7b","created_at":1743103949.0,"error":null,"incomplete_details":null,"instructions":"You are an expert at enriching contact information data.\\n    Your task is to use web search to find additional information about a person\\n    based on their basic contact details.\\n\\n    Please find the basic information, company information, and social media information for the person.\\n\\n    The input data is from an unspecified CSV dataset, but most likely a CSV dump from a CRM or other source like Mailchimp, etc.\\n\\n    You\'ll receive the header row and a single row from the dataset to enrich, in their raw form.\\n    \\n    Only include information you are confident about from reliable sources.\\n    Use null for fields where you cannot find reliable information.\\n    ","metadata":{},"model":"gpt-4o-2024-08-06","object":"response","output":[{"arguments":"{\\"input\\":\\"Eric,eric@trigger.dev\\"}","call_id":"call_OPlvy1ubdx75L8AgGIfVTWlW","name":"basic_info_agent","type":"function_call","id":"fc_67e5a7ce1418819281d73995bf0ffcf9003e29fb266e3c7b","status":"completed"}],"parallel_tool_calls":false,"temperature":1.0,"tool_choice":"auto","tools":[{"name":"basic_info_agent","parameters":{"properties":{"input":{"title":"Input","type":"string"}},"required":["input"],"title":"basic_info_agent_args","type":"object","additionalProperties":false},"strict":true,"type":"function","description":"Extract basic information from a person\'s contact details"},{"name":"company_info_agent","parameters":{"properties":{"input":{"title":"Input","type":"string"}},"required":["input"],"title":"company_info_agent_args","type":"object","additionalProperties":false},"strict":true,"type":"function","description":"Extract company information from a person\'s contact details"},{"name":"social_info_agent","parameters":{"properties":{"input":{"title":"Input","type":"string"}},"required":["input"],"title":"social_info_agent_args","type":"object","additionalProperties":false},"strict":true,"type":"function","description":"Extract social media information from a person\'s contact details"}],"top_p":1.0,"max_output_tokens":null,"previous_response_id":null,"reasoning":{"effort":null,"generate_summary":null},"status":"completed","text":{"format":{"schema_":{"$defs":{"BasicInfo":{"properties":{"name":{"description":"The name of the row","title":"Name","type":"string"},"email":{"description":"The email of the row","title":"Email","type":"string"},"firstName":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The first name of the row","title":"Firstname"},"lastName":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The last name of the row","title":"Lastname"},"preferredName":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The preferred name of the row","title":"Preferredname"}},"required":["name","email","firstName","lastName","preferredName"],"title":"BasicInfo","type":"object","additionalProperties":false},"CompanyInfo":{"properties":{"name":{"description":"The name of the company","title":"Name","type":"string"},"industry":{"description":"The industry of the company","title":"Industry","type":"string"}},"required":["name","industry"],"title":"CompanyInfo","type":"object","additionalProperties":false},"SocialInfo":{"properties":{"twitter":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The Twitter username of the person","title":"Twitter"},"linkedin":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The LinkedIn username of the person","title":"Linkedin"},"facebook":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The Facebook username of the person","title":"Facebook"},"instagram":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"The Instagram username of the person","title":"Instagram"}},"title":"SocialInfo","type":"object","additionalProperties":false,"required":["twitter","linkedin","facebook","instagram"]}},"properties":{"basicInfo":{"$ref":"#/$defs/BasicInfo"},"companyInfo":{"$ref":"#/$defs/CompanyInfo"},"socialInfo":{"$ref":"#/$defs/SocialInfo"}},"required":["basicInfo","companyInfo","socialInfo"],"title":"RowEnrichmentResult","type":"object","additionalProperties":false},"type":"json_schema","description":null,"name":"final_output","strict":true}},"truncation":"disabled","usage":{"input_tokens":702,"input_tokens_details":{"cached_tokens":0},"output_tokens":22,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":724},"user":null,"store":true}',
            "gen_ai.operation.name": "chat",
            raw_input:
              '[{"content":"\\n        Header row: Name,Email\\n        Row to enrich: Eric,eric@trigger.dev\\n        CSV URL: https://example.com/import.csv\\n        ","role":"user"}]',
            events:
              '[{"event.name":"gen_ai.system.message","content":"You are an expert at enriching contact information data.\\n    Your task is to use web search to find additional information about a person\\n    based on their basic contact details.\\n\\n    Please find the basic information, company information, and social media information for the person.\\n\\n    The input data is from an unspecified CSV dataset, but most likely a CSV dump from a CRM or other source like Mailchimp, etc.\\n\\n    You\'ll receive the header row and a single row from the dataset to enrich, in their raw form.\\n    \\n    Only include information you are confident about from reliable sources.\\n    Use null for fields where you cannot find reliable information.\\n    ","role":"system"},{"event.name":"gen_ai.user.message","content":"\\n        Header row: Name,Email\\n        Row to enrich: Eric,eric@trigger.dev\\n        CSV URL: https://example.com/import.csv\\n        ","role":"user"},{"event.name":"gen_ai.choice","index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_OPlvy1ubdx75L8AgGIfVTWlW","type":"function","function":{"name":"basic_info_agent","arguments":"{\\"input\\":\\"Eric,eric@trigger.dev\\"}"}}]}}]',
            "gen_ai.usage.input_tokens": 702,
            "gen_ai.usage.output_tokens": 22,
            "logfire.msg": "Responses API with 'gpt-4o'",
          },
          payloadType: "application/json",
          metadata: {
            "service.instance.id": "eae3f05bfa924058b1aa79c6decd79fe",
          },
          serviceName: "d3-demo",
          serviceNamespace: "unknown",
          environmentId: "cm8r871mw0002dy8n6ec3y0i2",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
          organizationId: "cm5ohng6o0002dyuzvr0qq4xo",
          projectId: "cm8r871lq0000dy8nhljain0w",
          projectRef: "proj_wkbbtayxrmeyqhankehb",
          runId: "run_cm8rr2zw50000efdyyq0376m5",
          runIsTest: false,
          attemptId: "deprecated",
          taskSlug: "row-agent-runner",
          taskPath: "src/trigger/d3Demo.ts",
          taskExportName: "@deprecated",
          workerId: "unmanaged",
          workerVersion: "20250327.54",
          queueId: "queue_pn4256pg6c2wc9rro3o7i",
          queueName: "task/row-agent-runner",
          batchId: "undefined",
          idempotencyKey: "undefined",
          machinePreset: "small-1x",
          style: {},
          output: {},
          payload: {},
        },
      ];

      const $events = enrichCreatableEvents(events);
      expect($events).toBeDefined();

      const event = $events[0];
      expect(event.message).toBe("Responses API with gpt-4o");
      expect(event.style).toMatchObject({
        icon: "tabler-brand-openai",
      });
      // Enrichment also adds model/token pills as accessories
      const style = event.style as Record<string, unknown>;
      expect(style.accessory).toMatchObject({
        style: "pills",
        items: expect.arrayContaining([
          expect.objectContaining({ text: "gpt-4o-2024-08-06" }),
          expect.objectContaining({ text: "724" }),
        ]),
      });
    });

    it("should handle missing properties gracefully", () => {
      const events = [
        {
          message: "Responses API with {missing.property!r}",
          properties: {},
          traceId: "test",
          spanId: "test",
          isPartial: false,
          isError: false,
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1),
          style: {},
          serviceName: "test",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        },
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].message).toBe("Responses API with {missing.property!r}");
      expect($events[0].style).toEqual({});
    });

    it("should handle multiple template variables in one message", () => {
      const events = [
        {
          message: "Using {gen_ai.request.model!r} with temperature {gen_ai.request.temperature}",
          properties: {
            "gen_ai.request.model": "gpt-4",
            "gen_ai.request.temperature": 0.7,
            "gen_ai.system": "openai",
          },
          traceId: "test",
          spanId: "test",
          isPartial: false,
          isError: false,
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1),
          style: {},
          serviceName: "test",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        },
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].message).toBe("Using 'gpt-4' with temperature 0.7");
      expect($events[0].style).toEqual({
        icon: "tabler-brand-openai",
      });
    });

    it("should handle non-string property values", () => {
      const events = [
        {
          message: "Count is {count!r} and enabled is {enabled!r}",
          properties: {
            count: 42,
            enabled: true,
            "gen_ai.system": "anthropic",
          },
          traceId: "test",
          spanId: "test",
          isPartial: false,
          isError: false,
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1),
          style: {},
          serviceName: "test",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        },
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].message).toBe("Count is 42 and enabled is true");
      expect($events[0].style).toEqual({
        icon: "tabler-brand-anthropic",
      });
    });

    it("should handle messages without any template variables", () => {
      const events = [
        {
          message: "Plain message without variables",
          properties: {
            "gen_ai.system": "openai",
          },
          traceId: "test",
          spanId: "test",
          isPartial: false,
          isError: false,
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1),
          style: {},
          serviceName: "test",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        },
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].message).toBe("Plain message without variables");
      expect($events[0].style).toEqual({
        icon: "tabler-brand-openai",
      });
    });

    it("should handle style enrichment without gen_ai.system", () => {
      const events = [
        {
          message: "Message without system",
          properties: {
            "some.other.property": "value",
          },
          traceId: "test",
          spanId: "test",
          isPartial: false,
          isError: false,
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1),
          style: { existingStyle: "value" },
          serviceName: "test",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        },
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].style).toEqual({ existingStyle: "value" });
    });

    it("should apply the first matching style enricher", () => {
      const events = [
        {
          message: "Agent workflow",
          properties: {
            "gen_ai.system": "openai",
            name: "Agent workflow",
          },
          traceId: "test",
          spanId: "test",
          isPartial: false,
          isError: false, // This would match the error enricher, but GenAI comes first
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1),
          style: { existingStyle: "value" },
          serviceName: "test",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        },
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].style).toEqual({
        existingStyle: "value",
        icon: "tabler-brand-openai", // GenAI enricher wins because it's first
      });
    });

    it("should fall back to next enricher if first doesn't match", () => {
      const events = [
        {
          message: "Agent workflow",
          properties: {
            "task.type": "background",
            name: "Agent workflow",
          },
          traceId: "test",
          spanId: "test",
          isPartial: false,
          isError: true,
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1),
          style: { existingStyle: "value" },
          serviceName: "test",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        },
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].style).toEqual({
        existingStyle: "value",
        icon: "tabler-brain",
      });
    });

    it("should preserve existing style if no enricher matches", () => {
      const events = [
        {
          message: "Test message",
          properties: {},
          traceId: "test",
          spanId: "test",
          isPartial: false,
          isError: false,
          kind: TaskEventKind.INTERNAL,
          level: TaskEventLevel.TRACE,
          status: TaskEventStatus.UNSET,
          startTime: BigInt(1),
          style: { existingStyle: "value" },
          serviceName: "test",
          environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        },
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].style).toEqual({
        existingStyle: "value",
      });
    });
  });

  describe("LLM cost enrichment", () => {
    const mockRegistry = {
      isLoaded: true,
      calculateCost: (responseModel: string, usageDetails: Record<string, number>) => {
        if (responseModel.startsWith("gpt-4o")) {
          const inputCost = (usageDetails["input"] ?? 0) * 0.0000025;
          const outputCost = (usageDetails["output"] ?? 0) * 0.00001;
          return {
            matchedModelId: "llm_model_gpt4o",
            matchedModelName: "gpt-4o",
            pricingTierId: "tier-standard",
            pricingTierName: "Standard",
            inputCost,
            outputCost,
            totalCost: inputCost + outputCost,
            costDetails: { input: inputCost, output: outputCost },
          };
        }
        return null;
      },
    };

    beforeEach(() => {
      setLlmPricingRegistry(mockRegistry);
    });

    afterEach(() => {
      setLlmPricingRegistry(undefined as any);
    });

    function makeGenAiEvent(overrides: Record<string, unknown> = {}) {
      return {
        message: "ai.streamText.doStream",
        traceId: "test-trace",
        spanId: "test-span",
        parentId: "test-parent",
        isPartial: false,
        isError: false,
        kind: TaskEventKind.INTERNAL,
        level: TaskEventLevel.TRACE,
        status: TaskEventStatus.UNSET,
        startTime: BigInt(1),
        duration: 5000000000,
        style: {},
        serviceName: "test",
        environmentId: "env-1",
        environmentType: RuntimeEnvironmentType.DEVELOPMENT,
        organizationId: "org-1",
        projectId: "proj-1",
        projectRef: "proj_test",
        runId: "run_test",
        runIsTest: false,
        taskSlug: "my-task",
        metadata: undefined,
        properties: {
          "gen_ai.system": "openai",
          "gen_ai.request.model": "gpt-4o",
          "gen_ai.response.model": "gpt-4o-2024-08-06",
          "gen_ai.usage.input_tokens": 702,
          "gen_ai.usage.output_tokens": 22,
          "operation.name": "ai.streamText.doStream",
          ...overrides,
        },
      };
    }

    it("should enrich spans with cost attributes and accessories", () => {
      const events = [makeGenAiEvent()];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      const event = $events[0];

      // Cost attributes
      expect(event.properties["trigger.llm.total_cost"]).toBeCloseTo(0.001975);
      expect(event.properties["trigger.llm.input_cost"]).toBeCloseTo(0.001755);
      expect(event.properties["trigger.llm.output_cost"]).toBeCloseTo(0.00022);
      expect(event.properties["trigger.llm.matched_model"]).toBe("gpt-4o");
      expect(event.properties["trigger.llm.pricing_tier"]).toBe("Standard");

      // Accessories (pills style)
      expect(event.style.accessory).toBeDefined();
      expect(event.style.accessory.style).toBe("pills");
      expect(event.style.accessory.items).toHaveLength(3);
      expect(event.style.accessory.items[0]).toEqual({
        text: "gpt-4o-2024-08-06",
        icon: "tabler-cube",
      });
      expect(event.style.accessory.items[1]).toEqual({
        text: "724",
        icon: "tabler-hash",
      });
      expect(event.style.accessory.items[2]).toEqual({
        text: "$0.001975",
        icon: "tabler-currency-dollar",
      });
    });

    it("should set _llmUsage side-channel for dual-write", () => {
      const events = [makeGenAiEvent()];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      const event = $events[0];

      expect(event._llmUsage).toBeDefined();
      expect(event._llmUsage.genAiSystem).toBe("openai");
      expect(event._llmUsage.responseModel).toBe("gpt-4o-2024-08-06");
      expect(event._llmUsage.inputTokens).toBe(702);
      expect(event._llmUsage.outputTokens).toBe(22);
      expect(event._llmUsage.totalCost).toBeCloseTo(0.001975);
      expect(event._llmUsage.operationName).toBe("ai.streamText.doStream");
    });

    it("should skip partial spans", () => {
      const events = [makeGenAiEvent()];
      events[0].isPartial = true;

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].properties["trigger.llm.total_cost"]).toBeUndefined();
      expect($events[0]._llmUsage).toBeUndefined();
    });

    it("should skip spans without gen_ai.response.model or gen_ai.request.model", () => {
      const events = [
        makeGenAiEvent({
          "gen_ai.response.model": undefined,
          "gen_ai.request.model": undefined,
        }),
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].properties["trigger.llm.total_cost"]).toBeUndefined();
    });

    it("should fall back to gen_ai.request.model when response.model is missing", () => {
      const events = [
        makeGenAiEvent({
          "gen_ai.response.model": undefined,
          "gen_ai.request.model": "gpt-4o",
        }),
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].properties["trigger.llm.matched_model"]).toBe("gpt-4o");
    });

    it("should skip spans with no token usage", () => {
      const events = [
        makeGenAiEvent({
          "gen_ai.usage.input_tokens": 0,
          "gen_ai.usage.output_tokens": 0,
        }),
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].properties["trigger.llm.total_cost"]).toBeUndefined();
    });

    it("should skip spans with unknown models", () => {
      const events = [
        makeGenAiEvent({
          "gen_ai.response.model": "unknown-model-xyz",
          "gen_ai.request.model": "unknown-model-xyz",
        }),
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].properties["trigger.llm.total_cost"]).toBeUndefined();
    });

    it("should not enrich non-span kinds like SPAN_EVENT or LOG", () => {
      const events = [makeGenAiEvent()];
      events[0].kind = "SPAN_EVENT" as any;

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].properties["trigger.llm.total_cost"]).toBeUndefined();
    });

    it("should enrich SERVER kind events", () => {
      const events = [makeGenAiEvent()];
      events[0].kind = TaskEventKind.SERVER;

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].properties["trigger.llm.total_cost"]).toBeCloseTo(0.001975);
    });

    it("should not enrich when registry is not loaded", () => {
      setLlmPricingRegistry({ isLoaded: false, calculateCost: () => null });
      const events = [makeGenAiEvent()];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].properties["trigger.llm.total_cost"]).toBeUndefined();
    });

    it("should format token counts with k/M suffixes in accessories", () => {
      const events = [
        makeGenAiEvent({
          "gen_ai.usage.input_tokens": 150000,
          "gen_ai.usage.output_tokens": 2000,
        }),
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0].style.accessory.items[1].text).toBe("152.0k");
    });

    it("should normalize alternate token attribute names", () => {
      const events = [
        makeGenAiEvent({
          "gen_ai.usage.input_tokens": undefined,
          "gen_ai.usage.output_tokens": undefined,
          "gen_ai.usage.prompt_tokens": 500,
          "gen_ai.usage.completion_tokens": 100,
        }),
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      expect($events[0]._llmUsage.inputTokens).toBe(500);
      expect($events[0]._llmUsage.outputTokens).toBe(100);
    });

    it("should prefer gen_ai.usage.total_tokens over input+output sum", () => {
      const events = [
        makeGenAiEvent({
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 50,
          "gen_ai.usage.total_tokens": 200, // higher than 100+50 (e.g. includes cached/reasoning)
        }),
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      const event = $events[0];

      // Pills should show the explicit total, not input+output
      expect(event.style.accessory.items[1]).toEqual({
        text: "200",
        icon: "tabler-hash",
      });

      // LLM usage should also use the explicit total
      expect(event._llmUsage.totalTokens).toBe(200);
      expect(event._llmUsage.inputTokens).toBe(100);
      expect(event._llmUsage.outputTokens).toBe(50);
    });

    it("should fall back to input+output when total_tokens is absent", () => {
      const events = [
        makeGenAiEvent({
          "gen_ai.usage.input_tokens": 300,
          "gen_ai.usage.output_tokens": 75,
        }),
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      const event = $events[0];

      expect(event.style.accessory.items[1]).toEqual({
        text: "375",
        icon: "tabler-hash",
      });
      expect(event._llmUsage.totalTokens).toBe(375);
    });

    it("should use total_tokens when only total is present without input/output breakdown", () => {
      const events = [
        makeGenAiEvent({
          "gen_ai.usage.input_tokens": undefined,
          "gen_ai.usage.output_tokens": undefined,
          "gen_ai.usage.total_tokens": 500,
        }),
      ];

      // @ts-expect-error
      const $events = enrichCreatableEvents(events);
      const event = $events[0];

      // Pills should show 500, not 0
      expect(event.style.accessory.items[1]).toEqual({
        text: "500",
        icon: "tabler-hash",
      });
    });
  });
});
