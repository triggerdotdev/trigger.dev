import type { DefaultModelDefinition } from "./types.js";

// Auto-generated from Langfuse default-model-prices.json — do not edit manually.
// Run `pnpm run sync-prices` to update from upstream.
// Source: https://github.com/langfuse/langfuse

export const defaultModelPrices: DefaultModelDefinition[] = [
  {
    "modelName": "gpt-4o",
    "matchPattern": "(?i)^(openai/)?(gpt-4o)$",
    "startDate": "2024-05-13T23:15:07.670Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000025,
          "input_cached_tokens": 0.00000125,
          "input_cache_read": 0.00000125,
          "output": 0.00001
        }
      }
    ]
  },
  {
    "modelName": "gpt-4o-2024-05-13",
    "matchPattern": "(?i)^(openai/)?(gpt-4o-2024-05-13)$",
    "startDate": "2024-05-13T23:15:07.670Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000005,
          "output": 0.000015
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-1106-preview",
    "matchPattern": "(?i)^(openai/)?(gpt-4-1106-preview)$",
    "startDate": "2024-04-23T10:37:17.092Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00001,
          "output": 0.00003
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-turbo-vision",
    "matchPattern": "(?i)^(openai/)?(gpt-4(-\\d{4})?-vision-preview)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00001,
          "output": 0.00003
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-32k",
    "matchPattern": "(?i)^(openai/)?(gpt-4-32k)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00006,
          "output": 0.00012
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-32k-0613",
    "matchPattern": "(?i)^(openai/)?(gpt-4-32k-0613)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00006,
          "output": 0.00012
        }
      }
    ]
  },
  {
    "modelName": "gpt-3.5-turbo-1106",
    "matchPattern": "(?i)^(openai/)?(gpt-)(35|3.5)(-turbo-1106)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000001,
          "output": 0.000002
        }
      }
    ]
  },
  {
    "modelName": "gpt-3.5-turbo-0613",
    "matchPattern": "(?i)^(openai/)?(gpt-)(35|3.5)(-turbo-0613)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000015,
          "output": 0.000002
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-0613",
    "matchPattern": "(?i)^(openai/)?(gpt-4-0613)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00003,
          "output": 0.00006
        }
      }
    ]
  },
  {
    "modelName": "gpt-3.5-turbo-instruct",
    "matchPattern": "(?i)^(openai/)?(gpt-)(35|3.5)(-turbo-instruct)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000015,
          "output": 0.000002
        }
      }
    ]
  },
  {
    "modelName": "text-ada-001",
    "matchPattern": "(?i)^(text-ada-001)$",
    "startDate": "2024-01-24T18:18:50.861Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 0.000004
        }
      }
    ]
  },
  {
    "modelName": "text-babbage-001",
    "matchPattern": "(?i)^(text-babbage-001)$",
    "startDate": "2024-01-24T18:18:50.861Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "text-curie-001",
    "matchPattern": "(?i)^(text-curie-001)$",
    "startDate": "2024-01-24T18:18:50.861Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 0.00002
        }
      }
    ]
  },
  {
    "modelName": "text-davinci-001",
    "matchPattern": "(?i)^(text-davinci-001)$",
    "startDate": "2024-01-24T18:18:50.861Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 0.00002
        }
      }
    ]
  },
  {
    "modelName": "text-davinci-002",
    "matchPattern": "(?i)^(text-davinci-002)$",
    "startDate": "2024-01-24T18:18:50.861Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 0.00002
        }
      }
    ]
  },
  {
    "modelName": "text-davinci-003",
    "matchPattern": "(?i)^(text-davinci-003)$",
    "startDate": "2024-01-24T18:18:50.861Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 0.00002
        }
      }
    ]
  },
  {
    "modelName": "text-embedding-ada-002-v2",
    "matchPattern": "(?i)^(text-embedding-ada-002-v2)$",
    "startDate": "2024-01-24T18:18:50.861Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 1e-7
        }
      }
    ]
  },
  {
    "modelName": "text-embedding-ada-002",
    "matchPattern": "(?i)^(text-embedding-ada-002)$",
    "startDate": "2024-01-24T18:18:50.861Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 1e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-3.5-turbo-16k-0613",
    "matchPattern": "(?i)^(openai/)?(gpt-)(35|3.5)(-turbo-16k-0613)$",
    "startDate": "2024-02-03T17:29:57.350Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "output": 0.000004
        }
      }
    ]
  },
  {
    "modelName": "gpt-3.5-turbo-0301",
    "matchPattern": "(?i)^(openai/)?(gpt-)(35|3.5)(-turbo-0301)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000002,
          "output": 0.000002
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-32k-0314",
    "matchPattern": "(?i)^(openai/)?(gpt-4-32k-0314)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00006,
          "output": 0.00012
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-0314",
    "matchPattern": "(?i)^(openai/)?(gpt-4-0314)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00003,
          "output": 0.00006
        }
      }
    ]
  },
  {
    "modelName": "gpt-4",
    "matchPattern": "(?i)^(openai/)?(gpt-4)$",
    "startDate": "2024-01-24T10:19:21.693Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00003,
          "output": 0.00006
        }
      }
    ]
  },
  {
    "modelName": "claude-instant-1.2",
    "matchPattern": "(?i)^(anthropic/)?(claude-instant-1.2)$",
    "startDate": "2024-01-30T15:44:13.447Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000163,
          "output": 0.00000551
        }
      }
    ]
  },
  {
    "modelName": "claude-2.0",
    "matchPattern": "(?i)^(anthropic/)?(claude-2.0)$",
    "startDate": "2024-01-30T15:44:13.447Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000008,
          "output": 0.000024
        }
      }
    ]
  },
  {
    "modelName": "claude-2.1",
    "matchPattern": "(?i)^(anthropic/)?(claude-2.1)$",
    "startDate": "2024-01-30T15:44:13.447Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000008,
          "output": 0.000024
        }
      }
    ]
  },
  {
    "modelName": "claude-1.3",
    "matchPattern": "(?i)^(anthropic/)?(claude-1.3)$",
    "startDate": "2024-01-30T15:44:13.447Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000008,
          "output": 0.000024
        }
      }
    ]
  },
  {
    "modelName": "claude-1.2",
    "matchPattern": "(?i)^(anthropic/)?(claude-1.2)$",
    "startDate": "2024-01-30T15:44:13.447Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000008,
          "output": 0.000024
        }
      }
    ]
  },
  {
    "modelName": "claude-1.1",
    "matchPattern": "(?i)^(anthropic/)?(claude-1.1)$",
    "startDate": "2024-01-30T15:44:13.447Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000008,
          "output": 0.000024
        }
      }
    ]
  },
  {
    "modelName": "claude-instant-1",
    "matchPattern": "(?i)^(anthropic/)?(claude-instant-1)$",
    "startDate": "2024-01-30T15:44:13.447Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000163,
          "output": 0.00000551
        }
      }
    ]
  },
  {
    "modelName": "babbage-002",
    "matchPattern": "(?i)^(babbage-002)$",
    "startDate": "2024-01-26T17:35:21.129Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 4e-7,
          "output": 0.0000016
        }
      }
    ]
  },
  {
    "modelName": "davinci-002",
    "matchPattern": "(?i)^(davinci-002)$",
    "startDate": "2024-01-26T17:35:21.129Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000006,
          "output": 0.000012
        }
      }
    ]
  },
  {
    "modelName": "text-embedding-3-small",
    "matchPattern": "(?i)^(text-embedding-3-small)$",
    "startDate": "2024-01-26T17:35:21.129Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 2e-8
        }
      }
    ]
  },
  {
    "modelName": "text-embedding-3-large",
    "matchPattern": "(?i)^(text-embedding-3-large)$",
    "startDate": "2024-01-26T17:35:21.129Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 1.3e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-3.5-turbo-0125",
    "matchPattern": "(?i)^(openai/)?(gpt-)(35|3.5)(-turbo-0125)$",
    "startDate": "2024-01-26T17:35:21.129Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 5e-7,
          "output": 0.0000015
        }
      }
    ]
  },
  {
    "modelName": "gpt-3.5-turbo",
    "matchPattern": "(?i)^(openai/)?(gpt-)(35|3.5)(-turbo)$",
    "startDate": "2024-02-13T12:00:37.424Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 5e-7,
          "output": 0.0000015
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-0125-preview",
    "matchPattern": "(?i)^(openai/)?(gpt-4-0125-preview)$",
    "startDate": "2024-01-26T17:35:21.129Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00001,
          "output": 0.00003
        }
      }
    ]
  },
  {
    "modelName": "ft:gpt-3.5-turbo-1106",
    "matchPattern": "(?i)^(ft:)(gpt-3.5-turbo-1106:)(.+)(:)(.*)(:)(.+)$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "output": 0.000006
        }
      }
    ]
  },
  {
    "modelName": "ft:gpt-3.5-turbo-0613",
    "matchPattern": "(?i)^(ft:)(gpt-3.5-turbo-0613:)(.+)(:)(.*)(:)(.+)$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000012,
          "output": 0.000016
        }
      }
    ]
  },
  {
    "modelName": "ft:davinci-002",
    "matchPattern": "(?i)^(ft:)(davinci-002:)(.+)(:)(.*)(:)(.+)$$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000012,
          "output": 0.000012
        }
      }
    ]
  },
  {
    "modelName": "ft:babbage-002",
    "matchPattern": "(?i)^(ft:)(babbage-002:)(.+)(:)(.*)(:)(.+)$$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000016,
          "output": 0.0000016
        }
      }
    ]
  },
  {
    "modelName": "chat-bison",
    "matchPattern": "(?i)^(chat-bison)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "codechat-bison-32k",
    "matchPattern": "(?i)^(codechat-bison-32k)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "codechat-bison",
    "matchPattern": "(?i)^(codechat-bison)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "text-bison-32k",
    "matchPattern": "(?i)^(text-bison-32k)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "chat-bison-32k",
    "matchPattern": "(?i)^(chat-bison-32k)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "text-unicorn",
    "matchPattern": "(?i)^(text-unicorn)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000025,
          "output": 0.0000075
        }
      }
    ]
  },
  {
    "modelName": "text-bison",
    "matchPattern": "(?i)^(text-bison)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "textembedding-gecko",
    "matchPattern": "(?i)^(textembedding-gecko)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 1e-7
        }
      }
    ]
  },
  {
    "modelName": "textembedding-gecko-multilingual",
    "matchPattern": "(?i)^(textembedding-gecko-multilingual)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "total": 1e-7
        }
      }
    ]
  },
  {
    "modelName": "code-gecko",
    "matchPattern": "(?i)^(code-gecko)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "code-bison",
    "matchPattern": "(?i)^(code-bison)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "code-bison-32k",
    "matchPattern": "(?i)^(code-bison-32k)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-01-31T13:25:02.141Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-3.5-turbo-16k",
    "matchPattern": "(?i)^(openai/)?(gpt-)(35|3.5)(-turbo-16k)$",
    "startDate": "2024-02-13T12:00:37.424Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 5e-7,
          "output": 0.0000015
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-turbo-preview",
    "matchPattern": "(?i)^(openai/)?(gpt-4-turbo-preview)$",
    "startDate": "2024-02-15T21:21:50.947Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00001,
          "output": 0.00003
        }
      }
    ]
  },
  {
    "modelName": "claude-3-opus-20240229",
    "matchPattern": "(?i)^(anthropic/)?(claude-3-opus-20240229|anthropic\\.claude-3-opus-20240229-v1:0|claude-3-opus@20240229)$",
    "startDate": "2024-03-07T17:55:38.139Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000015,
          "output": 0.000075
        }
      }
    ]
  },
  {
    "modelName": "claude-3-sonnet-20240229",
    "matchPattern": "(?i)^(anthropic/)?(claude-3-sonnet-20240229|anthropic\\.claude-3-sonnet-20240229-v1:0|claude-3-sonnet@20240229)$",
    "startDate": "2024-03-07T17:55:38.139Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-3-haiku-20240307",
    "matchPattern": "(?i)^(anthropic/)?(claude-3-haiku-20240307|anthropic\\.claude-3-haiku-20240307-v1:0|claude-3-haiku@20240307)$",
    "startDate": "2024-03-14T09:41:18.736Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 0.00000125
        }
      }
    ]
  },
  {
    "modelName": "gemini-1.0-pro-latest",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-1.0-pro-latest)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-04-11T10:27:46.517Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "output": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "gemini-1.0-pro",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-1.0-pro)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-04-11T10:27:46.517Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1.25e-7,
          "output": 3.75e-7
        }
      }
    ]
  },
  {
    "modelName": "gemini-1.0-pro-001",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-1.0-pro-001)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-04-11T10:27:46.517Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1.25e-7,
          "output": 3.75e-7
        }
      }
    ]
  },
  {
    "modelName": "gemini-pro",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-pro)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-04-11T10:27:46.517Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1.25e-7,
          "output": 3.75e-7
        }
      }
    ]
  },
  {
    "modelName": "gemini-1.5-pro-latest",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-1.5-pro-latest)(@[a-zA-Z0-9]+)?$",
    "startDate": "2024-04-11T10:27:46.517Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000025,
          "output": 0.0000075
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-turbo-2024-04-09",
    "matchPattern": "(?i)^(openai/)?(gpt-4-turbo-2024-04-09)$",
    "startDate": "2024-04-23T10:37:17.092Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00001,
          "output": 0.00003
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-turbo",
    "matchPattern": "(?i)^(openai/)?(gpt-4-turbo)$",
    "startDate": "2024-04-11T21:13:44.989Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00001,
          "output": 0.00003
        }
      }
    ]
  },
  {
    "modelName": "gpt-4-preview",
    "matchPattern": "(?i)^(openai/)?(gpt-4-preview)$",
    "startDate": "2024-04-23T10:37:17.092Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00001,
          "output": 0.00003
        }
      }
    ]
  },
  {
    "modelName": "claude-3-5-sonnet-20240620",
    "matchPattern": "(?i)^(anthropic/)?(claude-3-5-sonnet-20240620|(eu\\.|us\\.|apac\\.)?anthropic\\.claude-3-5-sonnet-20240620-v1:0|claude-3-5-sonnet@20240620)$",
    "startDate": "2024-06-25T11:47:24.475Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-4o-mini",
    "matchPattern": "(?i)^(openai/)?(gpt-4o-mini)$",
    "startDate": "2024-07-18T17:56:09.591Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1.5e-7,
          "output": 6e-7,
          "input_cached_tokens": 7.5e-8,
          "input_cache_read": 7.5e-8
        }
      }
    ]
  },
  {
    "modelName": "gpt-4o-mini-2024-07-18",
    "matchPattern": "(?i)^(openai/)?(gpt-4o-mini-2024-07-18)$",
    "startDate": "2024-07-18T17:56:09.591Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1.5e-7,
          "input_cached_tokens": 7.5e-8,
          "input_cache_read": 7.5e-8,
          "output": 6e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-4o-2024-08-06",
    "matchPattern": "(?i)^(openai/)?(gpt-4o-2024-08-06)$",
    "startDate": "2024-08-07T11:54:31.298Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000025,
          "input_cached_tokens": 0.00000125,
          "input_cache_read": 0.00000125,
          "output": 0.00001
        }
      }
    ]
  },
  {
    "modelName": "o1-preview",
    "matchPattern": "(?i)^(openai/)?(o1-preview)$",
    "startDate": "2024-09-13T10:01:35.373Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000015,
          "input_cached_tokens": 0.0000075,
          "input_cache_read": 0.0000075,
          "output": 0.00006,
          "output_reasoning_tokens": 0.00006,
          "output_reasoning": 0.00006
        }
      }
    ]
  },
  {
    "modelName": "o1-preview-2024-09-12",
    "matchPattern": "(?i)^(openai/)?(o1-preview-2024-09-12)$",
    "startDate": "2024-09-13T10:01:35.373Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000015,
          "input_cached_tokens": 0.0000075,
          "input_cache_read": 0.0000075,
          "output": 0.00006,
          "output_reasoning_tokens": 0.00006,
          "output_reasoning": 0.00006
        }
      }
    ]
  },
  {
    "modelName": "o1-mini",
    "matchPattern": "(?i)^(openai/)?(o1-mini)$",
    "startDate": "2024-09-13T10:01:35.373Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000011,
          "input_cached_tokens": 5.5e-7,
          "input_cache_read": 5.5e-7,
          "output": 0.0000044,
          "output_reasoning_tokens": 0.0000044,
          "output_reasoning": 0.0000044
        }
      }
    ]
  },
  {
    "modelName": "o1-mini-2024-09-12",
    "matchPattern": "(?i)^(openai/)?(o1-mini-2024-09-12)$",
    "startDate": "2024-09-13T10:01:35.373Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000011,
          "input_cached_tokens": 5.5e-7,
          "input_cache_read": 5.5e-7,
          "output": 0.0000044,
          "output_reasoning_tokens": 0.0000044,
          "output_reasoning": 0.0000044
        }
      }
    ]
  },
  {
    "modelName": "claude-3.5-sonnet-20241022",
    "matchPattern": "(?i)^(anthropic/)?(claude-3-5-sonnet-20241022|(eu\\.|us\\.|apac\\.)?anthropic\\.claude-3-5-sonnet-20241022-v2:0|claude-3-5-sonnet-V2@20241022)$",
    "startDate": "2024-10-22T18:48:01.676Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-3.5-sonnet-latest",
    "matchPattern": "(?i)^(anthropic/)?(claude-3-5-sonnet-latest)$",
    "startDate": "2024-10-22T18:48:01.676Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-3-5-haiku-20241022",
    "matchPattern": "(?i)^(anthropic/)?(claude-3-5-haiku-20241022|(eu\\.|us\\.|apac\\.)?anthropic\\.claude-3-5-haiku-20241022-v1:0|claude-3-5-haiku-V1@20241022)$",
    "startDate": "2024-11-05T10:30:50.566Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 8e-7,
          "input_tokens": 8e-7,
          "output": 0.000004,
          "output_tokens": 0.000004,
          "cache_creation_input_tokens": 0.000001,
          "input_cache_creation": 0.000001,
          "input_cache_creation_5m": 0.000001,
          "input_cache_creation_1h": 0.0000016,
          "cache_read_input_tokens": 8e-8,
          "input_cache_read": 8e-8
        }
      }
    ]
  },
  {
    "modelName": "claude-3.5-haiku-latest",
    "matchPattern": "(?i)^(anthropic/)?(claude-3-5-haiku-latest)$",
    "startDate": "2024-11-05T10:30:50.566Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 8e-7,
          "input_tokens": 8e-7,
          "output": 0.000004,
          "output_tokens": 0.000004,
          "cache_creation_input_tokens": 0.000001,
          "input_cache_creation": 0.000001,
          "input_cache_creation_5m": 0.000001,
          "input_cache_creation_1h": 0.0000016,
          "cache_read_input_tokens": 8e-8,
          "input_cache_read": 8e-8
        }
      }
    ]
  },
  {
    "modelName": "chatgpt-4o-latest",
    "matchPattern": "(?i)^(chatgpt-4o-latest)$",
    "startDate": "2024-11-25T12:47:17.504Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000005,
          "output": 0.000015
        }
      }
    ]
  },
  {
    "modelName": "gpt-4o-2024-11-20",
    "matchPattern": "(?i)^(openai/)?(gpt-4o-2024-11-20)$",
    "startDate": "2024-12-03T10:06:12.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000025,
          "input_cached_tokens": 0.00000125,
          "input_cache_read": 0.00000125,
          "output": 0.00001
        }
      }
    ]
  },
  {
    "modelName": "gpt-4o-audio-preview",
    "matchPattern": "(?i)^(openai/)?(gpt-4o-audio-preview)$",
    "startDate": "2024-12-03T10:19:56.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input_text_tokens": 0.0000025,
          "output_text_tokens": 0.00001,
          "input_audio_tokens": 0.0001,
          "input_audio": 0.0001,
          "output_audio_tokens": 0.0002,
          "output_audio": 0.0002
        }
      }
    ]
  },
  {
    "modelName": "gpt-4o-audio-preview-2024-10-01",
    "matchPattern": "(?i)^(openai/)?(gpt-4o-audio-preview-2024-10-01)$",
    "startDate": "2024-12-03T10:19:56.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input_text_tokens": 0.0000025,
          "output_text_tokens": 0.00001,
          "input_audio_tokens": 0.0001,
          "input_audio": 0.0001,
          "output_audio_tokens": 0.0002,
          "output_audio": 0.0002
        }
      }
    ]
  },
  {
    "modelName": "gpt-4o-realtime-preview",
    "matchPattern": "(?i)^(openai/)?(gpt-4o-realtime-preview)$",
    "startDate": "2024-12-03T10:19:56.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input_text_tokens": 0.000005,
          "input_cached_text_tokens": 0.0000025,
          "output_text_tokens": 0.00002,
          "input_audio_tokens": 0.0001,
          "input_audio": 0.0001,
          "input_cached_audio_tokens": 0.00002,
          "output_audio_tokens": 0.0002,
          "output_audio": 0.0002
        }
      }
    ]
  },
  {
    "modelName": "gpt-4o-realtime-preview-2024-10-01",
    "matchPattern": "(?i)^(openai/)?(gpt-4o-realtime-preview-2024-10-01)$",
    "startDate": "2024-12-03T10:19:56.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input_text_tokens": 0.000005,
          "input_cached_text_tokens": 0.0000025,
          "output_text_tokens": 0.00002,
          "input_audio_tokens": 0.0001,
          "input_audio": 0.0001,
          "input_cached_audio_tokens": 0.00002,
          "output_audio_tokens": 0.0002,
          "output_audio": 0.0002
        }
      }
    ]
  },
  {
    "modelName": "o1",
    "matchPattern": "(?i)^(openai/)?(o1)$",
    "startDate": "2025-01-17T00:01:35.373Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000015,
          "input_cached_tokens": 0.0000075,
          "input_cache_read": 0.0000075,
          "output": 0.00006,
          "output_reasoning_tokens": 0.00006,
          "output_reasoning": 0.00006
        }
      }
    ]
  },
  {
    "modelName": "o1-2024-12-17",
    "matchPattern": "(?i)^(openai/)?(o1-2024-12-17)$",
    "startDate": "2025-01-17T00:01:35.373Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000015,
          "input_cached_tokens": 0.0000075,
          "input_cache_read": 0.0000075,
          "output": 0.00006,
          "output_reasoning_tokens": 0.00006,
          "output_reasoning": 0.00006
        }
      }
    ]
  },
  {
    "modelName": "o3-mini",
    "matchPattern": "(?i)^(openai/)?(o3-mini)$",
    "startDate": "2025-01-31T20:41:35.373Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000011,
          "input_cached_tokens": 5.5e-7,
          "input_cache_read": 5.5e-7,
          "output": 0.0000044,
          "output_reasoning_tokens": 0.0000044,
          "output_reasoning": 0.0000044
        }
      }
    ]
  },
  {
    "modelName": "o3-mini-2025-01-31",
    "matchPattern": "(?i)^(openai/)?(o3-mini-2025-01-31)$",
    "startDate": "2025-01-31T20:41:35.373Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000011,
          "input_cached_tokens": 5.5e-7,
          "input_cache_read": 5.5e-7,
          "output": 0.0000044,
          "output_reasoning_tokens": 0.0000044,
          "output_reasoning": 0.0000044
        }
      }
    ]
  },
  {
    "modelName": "gemini-2.0-flash-001",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-2.0-flash-001)(@[a-zA-Z0-9]+)?$",
    "startDate": "2025-02-06T11:11:35.241Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1e-7,
          "output": 4e-7
        }
      }
    ]
  },
  {
    "modelName": "gemini-2.0-flash-lite-preview-02-05",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-2.0-flash-lite-preview-02-05)(@[a-zA-Z0-9]+)?$",
    "startDate": "2025-02-06T11:11:35.241Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 7.5e-8,
          "output": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-3.7-sonnet-20250219",
    "matchPattern": "(?i)^(anthropic/)?(claude-3.7-sonnet-20250219|(eu\\.|us\\.|apac\\.)?anthropic\\.claude-3.7-sonnet-20250219-v1:0|claude-3-7-sonnet-V1@20250219)$",
    "startDate": "2025-02-25T09:35:39.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-3.7-sonnet-latest",
    "matchPattern": "(?i)^(anthropic/)?(claude-3-7-sonnet-latest)$",
    "startDate": "2025-02-25T09:35:39.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-4.5-preview",
    "matchPattern": "(?i)^(openai/)?(gpt-4.5-preview)$",
    "startDate": "2025-02-27T21:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000075,
          "input_cached_tokens": 0.0000375,
          "input_cached_text_tokens": 0.0000375,
          "input_cache_read": 0.0000375,
          "output": 0.00015
        }
      }
    ]
  },
  {
    "modelName": "gpt-4.5-preview-2025-02-27",
    "matchPattern": "(?i)^(openai/)?(gpt-4.5-preview-2025-02-27)$",
    "startDate": "2025-02-27T21:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000075,
          "input_cached_tokens": 0.0000375,
          "input_cached_text_tokens": 0.0000375,
          "input_cache_read": 0.0000375,
          "output": 0.00015
        }
      }
    ]
  },
  {
    "modelName": "gpt-4.1",
    "matchPattern": "(?i)^(openai/)?(gpt-4.1)$",
    "startDate": "2025-04-15T10:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000002,
          "input_cached_tokens": 5e-7,
          "input_cached_text_tokens": 5e-7,
          "input_cache_read": 5e-7,
          "output": 0.000008
        }
      }
    ]
  },
  {
    "modelName": "gpt-4.1-2025-04-14",
    "matchPattern": "(?i)^(openai/)?(gpt-4.1-2025-04-14)$",
    "startDate": "2025-04-15T10:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000002,
          "input_cached_tokens": 5e-7,
          "input_cached_text_tokens": 5e-7,
          "input_cache_read": 5e-7,
          "output": 0.000008
        }
      }
    ]
  },
  {
    "modelName": "gpt-4.1-mini-2025-04-14",
    "matchPattern": "(?i)^(openai/)?(gpt-4.1-mini-2025-04-14)$",
    "startDate": "2025-04-15T10:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 4e-7,
          "input_cached_tokens": 1e-7,
          "input_cached_text_tokens": 1e-7,
          "input_cache_read": 1e-7,
          "output": 0.0000016
        }
      }
    ]
  },
  {
    "modelName": "gpt-4.1-nano-2025-04-14",
    "matchPattern": "(?i)^(openai/)?(gpt-4.1-nano-2025-04-14)$",
    "startDate": "2025-04-15T10:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1e-7,
          "input_cached_tokens": 2.5e-8,
          "input_cached_text_tokens": 2.5e-8,
          "input_cache_read": 2.5e-8,
          "output": 4e-7
        }
      }
    ]
  },
  {
    "modelName": "o3",
    "matchPattern": "(?i)^(openai/)?(o3)$",
    "startDate": "2025-04-16T23:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000002,
          "input_cached_tokens": 5e-7,
          "input_cache_read": 5e-7,
          "output": 0.000008,
          "output_reasoning_tokens": 0.000008,
          "output_reasoning": 0.000008
        }
      }
    ]
  },
  {
    "modelName": "o3-2025-04-16",
    "matchPattern": "(?i)^(openai/)?(o3-2025-04-16)$",
    "startDate": "2025-04-16T23:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000002,
          "input_cached_tokens": 5e-7,
          "input_cache_read": 5e-7,
          "output": 0.000008,
          "output_reasoning_tokens": 0.000008,
          "output_reasoning": 0.000008
        }
      }
    ]
  },
  {
    "modelName": "o4-mini",
    "matchPattern": "(?i)^(o4-mini)$",
    "startDate": "2025-04-16T23:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000011,
          "input_cached_tokens": 2.75e-7,
          "input_cache_read": 2.75e-7,
          "output": 0.0000044,
          "output_reasoning_tokens": 0.0000044,
          "output_reasoning": 0.0000044
        }
      }
    ]
  },
  {
    "modelName": "o4-mini-2025-04-16",
    "matchPattern": "(?i)^(o4-mini-2025-04-16)$",
    "startDate": "2025-04-16T23:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000011,
          "input_cached_tokens": 2.75e-7,
          "input_cache_read": 2.75e-7,
          "output": 0.0000044,
          "output_reasoning_tokens": 0.0000044,
          "output_reasoning": 0.0000044
        }
      }
    ]
  },
  {
    "modelName": "gemini-2.0-flash",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-2.0-flash)(@[a-zA-Z0-9]+)?$",
    "startDate": "2025-04-22T10:11:35.241Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1e-7,
          "output": 4e-7
        }
      }
    ]
  },
  {
    "modelName": "gemini-2.0-flash-lite-preview",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-2.0-flash-lite-preview)(@[a-zA-Z0-9]+)?$",
    "startDate": "2025-04-22T10:11:35.241Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 7.5e-8,
          "output": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-4.1-nano",
    "matchPattern": "(?i)^(openai/)?(gpt-4.1-nano)$",
    "startDate": "2025-04-22T10:11:35.241Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1e-7,
          "input_cached_tokens": 2.5e-8,
          "input_cached_text_tokens": 2.5e-8,
          "input_cache_read": 2.5e-8,
          "output": 4e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-4.1-mini",
    "matchPattern": "(?i)^(openai/)?(gpt-4.1-mini)$",
    "startDate": "2025-04-22T10:11:35.241Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 4e-7,
          "input_cached_tokens": 1e-7,
          "input_cached_text_tokens": 1e-7,
          "input_cache_read": 1e-7,
          "output": 0.0000016
        }
      }
    ]
  },
  {
    "modelName": "claude-sonnet-4-5-20250929",
    "matchPattern": "(?i)^(anthropic/)?(claude-sonnet-4-5(-20250929)?|(eu\\.|us\\.|apac\\.|global\\.)?anthropic\\.claude-sonnet-4-5(-20250929)?-v1(:0)?|claude-sonnet-4-5-V1(@20250929)?|claude-sonnet-4-5(@20250929)?)$",
    "startDate": "2025-09-29T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      },
      {
        "name": "Large Context",
        "isDefault": false,
        "priority": 1,
        "conditions": [
          {
            "usageDetailPattern": "input",
            "operator": "gt",
            "value": 200000
          }
        ],
        "prices": {
          "input": 0.000006,
          "input_tokens": 0.000006,
          "output": 0.0000225,
          "output_tokens": 0.0000225,
          "cache_creation_input_tokens": 0.0000075,
          "input_cache_creation": 0.0000075,
          "input_cache_creation_5m": 0.0000075,
          "input_cache_creation_1h": 0.000012,
          "cache_read_input_tokens": 6e-7,
          "input_cache_read": 6e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-sonnet-4-20250514",
    "matchPattern": "(?i)^(anthropic/)?(claude-sonnet-4(-20250514)?|(eu\\.|us\\.|apac\\.|global\\.)?anthropic\\.claude-sonnet-4(-20250514)?-v1(:0)?|claude-sonnet-4-V1(@20250514)?|claude-sonnet-4(@20250514)?)$",
    "startDate": "2025-05-22T17:09:02.131Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-sonnet-4-latest",
    "matchPattern": "(?i)^(anthropic/)?(claude-sonnet-4-latest)$",
    "startDate": "2025-05-22T17:09:02.131Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-opus-4-20250514",
    "matchPattern": "(?i)^(anthropic/)?(claude-opus-4(-20250514)?|(eu\\.|us\\.|apac\\.)?anthropic\\.claude-opus-4(-20250514)?-v1(:0)?|claude-opus-4(@20250514)?)$",
    "startDate": "2025-05-22T17:09:02.131Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000015,
          "input_tokens": 0.000015,
          "output": 0.000075,
          "output_tokens": 0.000075,
          "cache_creation_input_tokens": 0.00001875,
          "input_cache_creation": 0.00001875,
          "input_cache_creation_5m": 0.00001875,
          "input_cache_creation_1h": 0.00003,
          "cache_read_input_tokens": 0.0000015,
          "input_cache_read": 0.0000015
        }
      }
    ]
  },
  {
    "modelName": "o3-pro",
    "matchPattern": "(?i)^(openai/)?(o3-pro)$",
    "startDate": "2025-06-10T22:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00002,
          "output": 0.00008,
          "output_reasoning_tokens": 0.00008,
          "output_reasoning": 0.00008
        }
      }
    ]
  },
  {
    "modelName": "o3-pro-2025-06-10",
    "matchPattern": "(?i)^(openai/)?(o3-pro-2025-06-10)$",
    "startDate": "2025-06-10T22:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00002,
          "output": 0.00008,
          "output_reasoning_tokens": 0.00008,
          "output_reasoning": 0.00008
        }
      }
    ]
  },
  {
    "modelName": "o1-pro",
    "matchPattern": "(?i)^(openai/)?(o1-pro)$",
    "startDate": "2025-06-10T22:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00015,
          "output": 0.0006,
          "output_reasoning_tokens": 0.0006,
          "output_reasoning": 0.0006
        }
      }
    ]
  },
  {
    "modelName": "o1-pro-2025-03-19",
    "matchPattern": "(?i)^(openai/)?(o1-pro-2025-03-19)$",
    "startDate": "2025-06-10T22:26:54.132Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00015,
          "output": 0.0006,
          "output_reasoning_tokens": 0.0006,
          "output_reasoning": 0.0006
        }
      }
    ]
  },
  {
    "modelName": "gemini-2.5-flash",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-2.5-flash)$",
    "startDate": "2025-07-03T13:44:06.964Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 3e-7,
          "input_text": 3e-7,
          "input_modality_1": 3e-7,
          "prompt_token_count": 3e-7,
          "promptTokenCount": 3e-7,
          "input_cached_tokens": 3e-8,
          "cached_content_token_count": 3e-8,
          "output": 0.0000025,
          "output_text": 0.0000025,
          "output_modality_1": 0.0000025,
          "candidates_token_count": 0.0000025,
          "candidatesTokenCount": 0.0000025,
          "thoughtsTokenCount": 0.0000025,
          "thoughts_token_count": 0.0000025,
          "output_reasoning": 0.0000025,
          "input_audio_tokens": 0.000001
        }
      }
    ]
  },
  {
    "modelName": "gemini-2.5-flash-lite",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-2.5-flash-lite)$",
    "startDate": "2025-07-03T13:44:06.964Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 1e-7,
          "input_text": 1e-7,
          "input_modality_1": 1e-7,
          "prompt_token_count": 1e-7,
          "promptTokenCount": 1e-7,
          "input_cached_tokens": 2.5e-8,
          "cached_content_token_count": 2.5e-8,
          "output": 4e-7,
          "output_text": 4e-7,
          "output_modality_1": 4e-7,
          "candidates_token_count": 4e-7,
          "candidatesTokenCount": 4e-7,
          "thoughtsTokenCount": 4e-7,
          "thoughts_token_count": 4e-7,
          "output_reasoning": 4e-7,
          "input_audio_tokens": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-opus-4-1-20250805",
    "matchPattern": "(?i)^(anthropic/)?(claude-opus-4-1(-20250805)?|(eu\\.|us\\.|apac\\.)?anthropic\\.claude-opus-4-1(-20250805)?-v1(:0)?|claude-opus-4-1(@20250805)?)$",
    "startDate": "2025-08-05T15:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000015,
          "input_tokens": 0.000015,
          "output": 0.000075,
          "output_tokens": 0.000075,
          "cache_creation_input_tokens": 0.00001875,
          "input_cache_creation": 0.00001875,
          "input_cache_creation_5m": 0.00001875,
          "input_cache_creation_1h": 0.00003,
          "cache_read_input_tokens": 0.0000015,
          "input_cache_read": 0.0000015
        }
      }
    ]
  },
  {
    "modelName": "gpt-5",
    "matchPattern": "(?i)^(openai/)?(gpt-5)$",
    "startDate": "2025-08-07T16:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000125,
          "input_cached_tokens": 1.25e-7,
          "output": 0.00001,
          "input_cache_read": 1.25e-7,
          "output_reasoning_tokens": 0.00001,
          "output_reasoning": 0.00001
        }
      }
    ]
  },
  {
    "modelName": "gpt-5-2025-08-07",
    "matchPattern": "(?i)^(openai/)?(gpt-5-2025-08-07)$",
    "startDate": "2025-08-11T08:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000125,
          "input_cached_tokens": 1.25e-7,
          "output": 0.00001,
          "input_cache_read": 1.25e-7,
          "output_reasoning_tokens": 0.00001,
          "output_reasoning": 0.00001
        }
      }
    ]
  },
  {
    "modelName": "gpt-5-mini",
    "matchPattern": "(?i)^(openai/)?(gpt-5-mini)$",
    "startDate": "2025-08-07T16:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "input_cached_tokens": 2.5e-8,
          "output": 0.000002,
          "input_cache_read": 2.5e-8,
          "output_reasoning_tokens": 0.000002,
          "output_reasoning": 0.000002
        }
      }
    ]
  },
  {
    "modelName": "gpt-5-mini-2025-08-07",
    "matchPattern": "(?i)^(openai/)?(gpt-5-mini-2025-08-07)$",
    "startDate": "2025-08-11T08:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "input_cached_tokens": 2.5e-8,
          "output": 0.000002,
          "input_cache_read": 2.5e-8,
          "output_reasoning_tokens": 0.000002,
          "output_reasoning": 0.000002
        }
      }
    ]
  },
  {
    "modelName": "gpt-5-nano",
    "matchPattern": "(?i)^(openai/)?(gpt-5-nano)$",
    "startDate": "2025-08-07T16:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 5e-8,
          "input_cached_tokens": 5e-9,
          "output": 4e-7,
          "input_cache_read": 5e-9,
          "output_reasoning_tokens": 4e-7,
          "output_reasoning": 4e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-5-nano-2025-08-07",
    "matchPattern": "(?i)^(openai/)?(gpt-5-nano-2025-08-07)$",
    "startDate": "2025-08-11T08:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 5e-8,
          "input_cached_tokens": 5e-9,
          "output": 4e-7,
          "input_cache_read": 5e-9,
          "output_reasoning_tokens": 4e-7,
          "output_reasoning": 4e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-5-chat-latest",
    "matchPattern": "(?i)^(openai/)?(gpt-5-chat-latest)$",
    "startDate": "2025-08-07T16:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000125,
          "input_cached_tokens": 1.25e-7,
          "output": 0.00001,
          "input_cache_read": 1.25e-7,
          "output_reasoning_tokens": 0.00001,
          "output_reasoning": 0.00001
        }
      }
    ]
  },
  {
    "modelName": "gpt-5-pro",
    "matchPattern": "(?i)^(openai/)?(gpt-5-pro)$",
    "startDate": "2025-10-07T08:03:54.727Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000015,
          "output": 0.00012,
          "output_reasoning_tokens": 0.00012,
          "output_reasoning": 0.00012
        }
      }
    ]
  },
  {
    "modelName": "gpt-5-pro-2025-10-06",
    "matchPattern": "(?i)^(openai/)?(gpt-5-pro-2025-10-06)$",
    "startDate": "2025-10-07T08:03:54.727Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000015,
          "output": 0.00012,
          "output_reasoning_tokens": 0.00012,
          "output_reasoning": 0.00012
        }
      }
    ]
  },
  {
    "modelName": "claude-haiku-4-5-20251001",
    "matchPattern": "(?i)^(anthropic/)?(claude-haiku-4-5-20251001|(eu\\.|us\\.|apac\\.|global\\.)?anthropic\\.claude-haiku-4-5-20251001-v1:0|claude-4-5-haiku@20251001)$",
    "startDate": "2025-10-16T08:20:44.558Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000001,
          "input_tokens": 0.000001,
          "output": 0.000005,
          "output_tokens": 0.000005,
          "cache_creation_input_tokens": 0.00000125,
          "input_cache_creation": 0.00000125,
          "input_cache_creation_5m": 0.00000125,
          "input_cache_creation_1h": 0.000002,
          "cache_read_input_tokens": 1e-7,
          "input_cache_read": 1e-7
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.1",
    "matchPattern": "(?i)^(openai/)?(gpt-5.1)$",
    "startDate": "2025-11-14T08:57:23.481Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000125,
          "input_cached_tokens": 1.25e-7,
          "output": 0.00001,
          "input_cache_read": 1.25e-7,
          "output_reasoning_tokens": 0.00001,
          "output_reasoning": 0.00001
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.1-2025-11-13",
    "matchPattern": "(?i)^(openai/)?(gpt-5.1-2025-11-13)$",
    "startDate": "2025-11-14T08:57:23.481Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000125,
          "input_cached_tokens": 1.25e-7,
          "output": 0.00001,
          "input_cache_read": 1.25e-7,
          "output_reasoning_tokens": 0.00001,
          "output_reasoning": 0.00001
        }
      }
    ]
  },
  {
    "modelName": "claude-opus-4-5-20251101",
    "matchPattern": "(?i)^(anthropic/)?(claude-opus-4-5(-20251101)?|(eu\\.|us\\.|apac\\.|global\\.)?anthropic\\.claude-opus-4-5(-20251101)?-v1(:0)?|claude-opus-4-5(@20251101)?)$",
    "startDate": "2025-11-24T20:53:27.571Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000005,
          "input_tokens": 0.000005,
          "output": 0.000025,
          "output_tokens": 0.000025,
          "cache_creation_input_tokens": 0.00000625,
          "input_cache_creation": 0.00000625,
          "input_cache_creation_5m": 0.00000625,
          "input_cache_creation_1h": 0.00001,
          "cache_read_input_tokens": 5e-7,
          "input_cache_read": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-sonnet-4-6",
    "matchPattern": "(?i)^(anthropic\\/)?(claude-sonnet-4-6|(eu\\.|us\\.|apac\\.|global\\.)?anthropic\\.claude-sonnet-4-6(-v1(:0)?)?|claude-sonnet-4-6)$",
    "startDate": "2026-02-18T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000003,
          "input_tokens": 0.000003,
          "output": 0.000015,
          "output_tokens": 0.000015,
          "cache_creation_input_tokens": 0.00000375,
          "input_cache_creation": 0.00000375,
          "input_cache_creation_5m": 0.00000375,
          "input_cache_creation_1h": 0.000006,
          "cache_read_input_tokens": 3e-7,
          "input_cache_read": 3e-7
        }
      },
      {
        "name": "Large Context",
        "isDefault": false,
        "priority": 1,
        "conditions": [
          {
            "usageDetailPattern": "input",
            "operator": "gt",
            "value": 200000
          }
        ],
        "prices": {
          "input": 0.000006,
          "input_tokens": 0.000006,
          "output": 0.0000225,
          "output_tokens": 0.0000225,
          "cache_creation_input_tokens": 0.0000075,
          "input_cache_creation": 0.0000075,
          "input_cache_creation_5m": 0.0000075,
          "input_cache_creation_1h": 0.000012,
          "cache_read_input_tokens": 6e-7,
          "input_cache_read": 6e-7
        }
      }
    ]
  },
  {
    "modelName": "claude-opus-4-6",
    "matchPattern": "(?i)^(anthropic/)?(claude-opus-4-6|(eu\\.|us\\.|apac\\.|global\\.)?anthropic\\.claude-opus-4-6-v1(:0)?|claude-opus-4-6)$",
    "startDate": "2026-02-09T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000005,
          "input_tokens": 0.000005,
          "output": 0.000025,
          "output_tokens": 0.000025,
          "cache_creation_input_tokens": 0.00000625,
          "input_cache_creation": 0.00000625,
          "input_cache_creation_5m": 0.00000625,
          "input_cache_creation_1h": 0.00001,
          "cache_read_input_tokens": 5e-7,
          "input_cache_read": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "gemini-2.5-pro",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-2.5-pro)$",
    "startDate": "2025-11-26T13:27:53.545Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000125,
          "input_text": 0.00000125,
          "input_modality_1": 0.00000125,
          "prompt_token_count": 0.00000125,
          "promptTokenCount": 0.00000125,
          "input_cached_tokens": 1.25e-7,
          "cached_content_token_count": 1.25e-7,
          "output": 0.00001,
          "output_text": 0.00001,
          "output_modality_1": 0.00001,
          "candidates_token_count": 0.00001,
          "candidatesTokenCount": 0.00001,
          "thoughtsTokenCount": 0.00001,
          "thoughts_token_count": 0.00001,
          "output_reasoning": 0.00001
        }
      },
      {
        "name": "Large Context",
        "isDefault": false,
        "priority": 1,
        "conditions": [
          {
            "usageDetailPattern": "(input|prompt|cached)",
            "operator": "gt",
            "value": 200000
          }
        ],
        "prices": {
          "input": 0.0000025,
          "input_text": 0.0000025,
          "input_modality_1": 0.0000025,
          "prompt_token_count": 0.0000025,
          "promptTokenCount": 0.0000025,
          "input_cached_tokens": 2.5e-7,
          "cached_content_token_count": 2.5e-7,
          "output": 0.000015,
          "output_text": 0.000015,
          "output_modality_1": 0.000015,
          "candidates_token_count": 0.000015,
          "candidatesTokenCount": 0.000015,
          "thoughtsTokenCount": 0.000015,
          "thoughts_token_count": 0.000015,
          "output_reasoning": 0.000015
        }
      }
    ]
  },
  {
    "modelName": "gemini-3-pro-preview",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-3-pro-preview)$",
    "startDate": "2025-11-26T13:27:53.545Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000002,
          "input_text": 0.000002,
          "input_modality_1": 0.000002,
          "prompt_token_count": 0.000002,
          "promptTokenCount": 0.000002,
          "input_cached_tokens": 2e-7,
          "cached_content_token_count": 2e-7,
          "output": 0.000012,
          "output_text": 0.000012,
          "output_modality_1": 0.000012,
          "candidates_token_count": 0.000012,
          "candidatesTokenCount": 0.000012,
          "thoughtsTokenCount": 0.000012,
          "thoughts_token_count": 0.000012,
          "output_reasoning": 0.000012
        }
      },
      {
        "name": "Large Context",
        "isDefault": false,
        "priority": 1,
        "conditions": [
          {
            "usageDetailPattern": "(input|prompt|cached)",
            "operator": "gt",
            "value": 200000
          }
        ],
        "prices": {
          "input": 0.000004,
          "input_text": 0.000004,
          "input_modality_1": 0.000004,
          "prompt_token_count": 0.000004,
          "promptTokenCount": 0.000004,
          "input_cached_tokens": 4e-7,
          "cached_content_token_count": 4e-7,
          "output": 0.000018,
          "output_text": 0.000018,
          "output_modality_1": 0.000018,
          "candidates_token_count": 0.000018,
          "candidatesTokenCount": 0.000018,
          "thoughtsTokenCount": 0.000018,
          "thoughts_token_count": 0.000018,
          "output_reasoning": 0.000018
        }
      }
    ]
  },
  {
    "modelName": "gemini-3.1-pro-preview",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-3.1-pro-preview(-customtools)?)$",
    "startDate": "2026-02-19T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000002,
          "input_modality_1": 0.000002,
          "input_text": 0.000002,
          "prompt_token_count": 0.000002,
          "promptTokenCount": 0.000002,
          "input_cached_tokens": 2e-7,
          "cached_content_token_count": 2e-7,
          "output": 0.000012,
          "output_text": 0.000012,
          "output_modality_1": 0.000012,
          "candidates_token_count": 0.000012,
          "candidatesTokenCount": 0.000012,
          "thoughtsTokenCount": 0.000012,
          "thoughts_token_count": 0.000012,
          "output_reasoning": 0.000012
        }
      },
      {
        "name": "Large Context",
        "isDefault": false,
        "priority": 1,
        "conditions": [
          {
            "usageDetailPattern": "(input|prompt|cached)",
            "operator": "gt",
            "value": 200000
          }
        ],
        "prices": {
          "input": 0.000004,
          "input_modality_1": 0.000004,
          "input_text": 0.000004,
          "prompt_token_count": 0.000004,
          "promptTokenCount": 0.000004,
          "input_cached_tokens": 4e-7,
          "cached_content_token_count": 4e-7,
          "output": 0.000018,
          "output_text": 0.000018,
          "output_modality_1": 0.000018,
          "candidates_token_count": 0.000018,
          "candidatesTokenCount": 0.000018,
          "thoughtsTokenCount": 0.000018,
          "thoughts_token_count": 0.000018,
          "output_reasoning": 0.000018
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.2",
    "matchPattern": "(?i)^(openai/)?(gpt-5.2)$",
    "startDate": "2025-12-12T09:00:06.513Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000175,
          "input_cached_tokens": 1.75e-7,
          "input_cache_read": 1.75e-7,
          "output": 0.000014,
          "output_reasoning_tokens": 0.000014,
          "output_reasoning": 0.000014
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.2-2025-12-11",
    "matchPattern": "(?i)^(openai/)?(gpt-5.2-2025-12-11)$",
    "startDate": "2025-12-12T09:00:06.513Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00000175,
          "input_cached_tokens": 1.75e-7,
          "input_cache_read": 1.75e-7,
          "output": 0.000014,
          "output_reasoning_tokens": 0.000014,
          "output_reasoning": 0.000014
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.2-pro",
    "matchPattern": "(?i)^(openai/)?(gpt-5.2-pro)$",
    "startDate": "2025-12-12T09:00:06.513Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000021,
          "output": 0.000168,
          "output_reasoning_tokens": 0.000168,
          "output_reasoning": 0.000168
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.2-pro-2025-12-11",
    "matchPattern": "(?i)^(openai/)?(gpt-5.2-pro-2025-12-11)$",
    "startDate": "2025-12-12T09:00:06.513Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.000021,
          "output": 0.000168,
          "output_reasoning_tokens": 0.000168,
          "output_reasoning": 0.000168
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.4",
    "matchPattern": "(?i)^(openai/)?(gpt-5.4)$",
    "startDate": "2026-03-05T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000025,
          "input_cached_tokens": 2.5e-7,
          "input_cache_read": 2.5e-7,
          "output": 0.000015,
          "output_reasoning_tokens": 0.000015,
          "output_reasoning": 0.000015
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.4-pro",
    "matchPattern": "(?i)^(openai/)?(gpt-5.4-pro)$",
    "startDate": "2026-03-05T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00003,
          "output": 0.00018,
          "output_reasoning_tokens": 0.00018,
          "output_reasoning": 0.00018
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.4-2026-03-05",
    "matchPattern": "(?i)^(openai/)?(gpt-5.4-2026-03-05)$",
    "startDate": "2026-03-05T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.0000025,
          "input_cached_tokens": 2.5e-7,
          "input_cache_read": 2.5e-7,
          "output": 0.000015,
          "output_reasoning_tokens": 0.000015,
          "output_reasoning": 0.000015
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.4-pro-2026-03-05",
    "matchPattern": "(?i)^(openai/)?(gpt-5.4-pro-2026-03-05)$",
    "startDate": "2026-03-05T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 0.00003,
          "output": 0.00018,
          "output_reasoning_tokens": 0.00018,
          "output_reasoning": 0.00018
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.4-mini",
    "matchPattern": "(?i)^(openai\\/)?(gpt-5.4-mini)$",
    "startDate": "2026-03-18T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 7.5e-7,
          "input_cached_tokens": 7.5e-8,
          "input_cache_read": 7.5e-8,
          "output": 0.0000045
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.4-mini-2026-03-17",
    "matchPattern": "(?i)^(openai\\/)?(gpt-5.4-mini-2026-03-17)$",
    "startDate": "2026-03-18T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 7.5e-7,
          "input_cached_tokens": 7.5e-8,
          "input_cache_read": 7.5e-8,
          "output": 0.0000045
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.4-nano",
    "matchPattern": "(?i)^(openai\\/)?(gpt-5.4-nano)$",
    "startDate": "2026-03-18T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2e-7,
          "input_cached_tokens": 2e-8,
          "input_cache_read": 2e-8,
          "output": 0.00000125
        }
      }
    ]
  },
  {
    "modelName": "gpt-5.4-nano-2026-03-17",
    "matchPattern": "(?i)^(openai\\/)?(gpt-5.4-nano-2026-03-17)$",
    "startDate": "2026-03-18T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2e-7,
          "input_cached_tokens": 2e-8,
          "input_cache_read": 2e-8,
          "output": 0.00000125
        }
      }
    ]
  },
  {
    "modelName": "gemini-3-flash-preview",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-3-flash-preview)$",
    "startDate": "2025-12-21T12:01:42.282Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 5e-7,
          "input_text": 5e-7,
          "input_modality_1": 5e-7,
          "prompt_token_count": 5e-7,
          "promptTokenCount": 5e-7,
          "input_cached_tokens": 5e-8,
          "cached_content_token_count": 5e-8,
          "output": 0.000003,
          "output_text": 0.000003,
          "output_modality_1": 0.000003,
          "candidates_token_count": 0.000003,
          "candidatesTokenCount": 0.000003,
          "thoughtsTokenCount": 0.000003,
          "thoughts_token_count": 0.000003,
          "output_reasoning": 0.000003
        }
      }
    ]
  },
  {
    "modelName": "gemini-3.1-flash-lite-preview",
    "matchPattern": "(?i)^(google(ai)?/)?(gemini-3.1-flash-lite-preview)$",
    "startDate": "2026-03-03T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input": 2.5e-7,
          "input_modality_1": 2.5e-7,
          "input_text": 2.5e-7,
          "prompt_token_count": 2.5e-7,
          "promptTokenCount": 2.5e-7,
          "input_cached_tokens": 2.5e-8,
          "cached_content_token_count": 2.5e-8,
          "output": 0.0000015,
          "output_text": 0.0000015,
          "output_modality_1": 0.0000015,
          "candidates_token_count": 0.0000015,
          "candidatesTokenCount": 0.0000015,
          "thoughtsTokenCount": 0.0000015,
          "thoughts_token_count": 0.0000015,
          "output_reasoning": 0.0000015,
          "input_audio_tokens": 5e-7
        }
      }
    ]
  },
  {
    "modelName": "gemini-live-2.5-flash-native-audio",
    "matchPattern": "(?i)^(google/)?(gemini-live-2.5-flash-native-audio)$",
    "startDate": "2026-03-16T00:00:00.000Z",
    "pricingTiers": [
      {
        "name": "Standard",
        "isDefault": true,
        "priority": 0,
        "conditions": [],
        "prices": {
          "input_text": 5e-7,
          "input_audio": 0.000003,
          "input_image": 0.000003,
          "output_text": 0.000002,
          "output_audio": 0.000012
        }
      }
    ]
  }
];
