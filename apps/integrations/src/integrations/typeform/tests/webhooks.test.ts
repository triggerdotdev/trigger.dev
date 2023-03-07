import { validate } from "core/schemas/validate";
import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import { webhooks, events } from "../webhooks/webhooks";

const authToken = () => process.env.TYPEFORM_ACCESS_TOKEN ?? "";

describe("typeform.webhooks", async () => {
  test("subscribe", async () => {
    const accessToken = authToken();

    const subscription = webhooks.formResponse.subscription;
    expect(subscription.type).toEqual("automatic");
    if (subscription.type !== "automatic")
      throw new Error("Invalid subscription type");

    const nockDone = await startNock("typeform.webhook.subscribe");
    const result = await subscription.subscribe({
      webhookId: "abcdefghijklmnopqrstuvwxyz",
      callbackUrl: "https://example.com",
      events: ["form_response"],
      secret: "123456",
      inputData: {
        form_id: "NclFXN1d",
      },
      credentials: {
        type: "api_key",
        name: "accessToken",
        api_key: accessToken,
        scopes: ["webhooks:write"],
      },
    });

    expect(result.success).toEqual(true);
    expect(result).toMatchInlineSnapshot(`
      {
        "callbackUrl": "https://example.com",
        "data": {
          "created_at": "2023-03-03T16:43:11.537925Z",
          "enabled": true,
          "form_id": "NclFXN1d",
          "id": "01GTM5P9SHVPWH626RX1HZ2ZRR",
          "secret": "123456",
          "tag": "abcdefghijklmnopqrstuvwxyz",
          "updated_at": "2023-03-03T16:43:11.537925Z",
          "url": "https://example.com",
          "verify_ssl": true,
        },
        "events": [
          "form_response",
        ],
        "headers": {
          "access-control-allow-headers": "X-Typeform-Key, Content-Type, Authorization, Typeform-Version, typeform-app",
          "access-control-allow-methods": "GET, OPTIONS, POST, PUT, PATCH, DELETE",
          "access-control-expose-headers": "Location, X-Request-Id",
          "connection": "close",
          "content-length": "257",
          "content-type": "application/json; charset=UTF-8",
          "date": "Fri, 03 Mar 2023 16:43:11 GMT",
          "server": "istio-envoy",
          "set-cookie": "AWSALBTG=Y11vNY5M69UbXGI3Morm47RBczox072FvVPkuZwkeF3R/wN2w5GHZG76HnQeb9WAwNjzFZAcEn8PfOtDaNysQXS59YP1aCwW3mmsEfP84BTbD5YY6ud89VOIsc+ycvhCA44kyU8BjscMCdRLGjhOCETiAJ92LAABl3wohYQ/XWM+; Expires=Fri, 10 Mar 2023 16:43:11 GMT; Path=/, AWSALBTGCORS=Y11vNY5M69UbXGI3Morm47RBczox072FvVPkuZwkeF3R/wN2w5GHZG76HnQeb9WAwNjzFZAcEn8PfOtDaNysQXS59YP1aCwW3mmsEfP84BTbD5YY6ud89VOIsc+ycvhCA44kyU8BjscMCdRLGjhOCETiAJ92LAABl3wohYQ/XWM+; Expires=Fri, 10 Mar 2023 16:43:11 GMT; Path=/; SameSite=None; Secure",
          "strict-transport-security": "max-age=63072000; includeSubDomains",
          "x-envoy-upstream-service-time": "15",
        },
        "secret": "123456",
        "status": 200,
        "success": true,
      }
    `);
    stopNock(nockDone);
  });

  test("receiving (correct signature)", async () => {
    const accessToken = authToken();

    //explicitly pass in a payload (this is hardcoded, not from a request)
    try {
      const result = await webhooks.formResponse.receive({
        credentials: {
          type: "api_key",
          name: "accessToken",
          api_key: accessToken,
          scopes: ["webhooks:write"],
        },
        secret: "123456",
        subscriptionData: {
          id: "01GTH8BG8S4KK1XW38SNDN1SRV",
          form_id: "NclFXN1d",
          tag: "myTag",
          url: "https://example.com",
          enabled: true,
          verify_ssl: true,
          secret: "123456",
          created_at: "2023-03-02T13:32:00.154368Z",
          updated_at: "2023-03-02T15:08:01.697884Z",
        },
        request: {
          method: "POST",
          searchParams: new URLSearchParams(),
          headers: {
            "content-type": "application/json",
            "typeform-signature":
              "sha256=VsvwNrh0fT5VWF+05H3azXZXJyFkhHTtONMxIVm6PZ4=",
          },
          body: events.formResponse.examples[0],
          rawBody: Buffer.from(JSON.stringify(events.formResponse.examples[0])),
        },
      });

      expect(result).toMatchInlineSnapshot(`
        {
          "eventResults": [
            {
              "displayProperties": {
                "title": "New response",
              },
              "event": "form_response",
              "payload": {
                "event_id": "LtWXD3crgy",
                "event_type": "form_response",
                "form_response": {
                  "answers": [
                    {
                      "field": {
                        "id": "DlXFaesGBpoF",
                        "type": "long_text",
                      },
                      "text": "It's cold right now! I live in an older medium-sized city with a university. Geographically, the area is hilly.",
                      "type": "text",
                    },
                    {
                      "email": "laura@example.com",
                      "field": {
                        "id": "SMEUb7VJz92Q",
                        "type": "email",
                      },
                      "type": "email",
                    },
                    {
                      "field": {
                        "id": "JwWggjAKtOkA",
                        "type": "short_text",
                      },
                      "text": "Laura",
                      "type": "text",
                    },
                    {
                      "date": "2005-10-15",
                      "field": {
                        "id": "KoJxDM3c6x8h",
                        "type": "date",
                      },
                      "type": "date",
                    },
                    {
                      "choices": {
                        "labels": [
                          "London",
                          "Sydney",
                        ],
                      },
                      "field": {
                        "id": "PNe8ZKBK8C2Q",
                        "type": "picture_choice",
                      },
                      "type": "choices",
                    },
                    {
                      "field": {
                        "id": "Q7M2XAwY04dW",
                        "type": "number",
                      },
                      "number": 5,
                      "type": "number",
                    },
                    {
                      "boolean": true,
                      "field": {
                        "id": "gFFf3xAkJKsr",
                        "type": "legal",
                      },
                      "type": "boolean",
                    },
                    {
                      "choice": {
                        "label": "London",
                      },
                      "field": {
                        "id": "k6TP9oLGgHjl",
                        "type": "multiple_choice",
                      },
                      "type": "choice",
                    },
                    {
                      "boolean": false,
                      "field": {
                        "id": "RUqkXSeXBXSd",
                        "type": "yes_no",
                      },
                      "type": "boolean",
                    },
                    {
                      "field": {
                        "id": "NRsxU591jIW9",
                        "type": "opinion_scale",
                      },
                      "number": 2,
                      "type": "number",
                    },
                    {
                      "field": {
                        "id": "WOTdC00F8A3h",
                        "type": "rating",
                      },
                      "number": 3,
                      "type": "number",
                    },
                    {
                      "field": {
                        "id": "pn48RmPazVdM",
                        "type": "number",
                      },
                      "number": 4,
                      "type": "number",
                    },
                    {
                      "field": {
                        "id": "M5tXK5kG7IeA",
                        "ref": "readable_ref_calendly",
                        "type": "calendly",
                      },
                      "type": "url",
                      "url": "https://calendly.com/scheduled_events/EVENT_TYPE/invitees/INVITEE",
                    },
                  ],
                  "calculated": {
                    "score": 9,
                  },
                  "definition": {
                    "endings": [
                      {
                        "id": "dN5FLyFpCMFo",
                        "properties": {
                          "button_mode": "default_redirect",
                          "button_text": "Create a typeform",
                          "share_icons": true,
                          "show_button": true,
                        },
                        "ref": "01GRC8GR2017M6WW347T86VV39",
                        "title": "Bye!",
                        "type": "thankyou_screen",
                      },
                    ],
                    "fields": [
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "DlXFaesGBpoF",
                        "ref": "readable_ref_long_text",
                        "title": "Thanks, {{answer_60906475}}! What's it like where you live? Tell us in a few sentences.",
                        "type": "long_text",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "SMEUb7VJz92Q",
                        "ref": "readable_ref_email",
                        "title": "If you're OK with our city management following up if they have further questions, please give us your email address.",
                        "type": "email",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "JwWggjAKtOkA",
                        "ref": "readable_ref_short_text",
                        "title": "What is your first name?",
                        "type": "short_text",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "KoJxDM3c6x8h",
                        "ref": "readable_ref_date",
                        "title": "When did you move to the place where you live?",
                        "type": "date",
                      },
                      {
                        "allow_multiple_selections": true,
                        "allow_other_choice": false,
                        "id": "PNe8ZKBK8C2Q",
                        "ref": "readable_ref_picture_choice",
                        "title": "Which pictures do you like? You can choose as many as you like.",
                        "type": "picture_choice",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "Q7M2XAwY04dW",
                        "ref": "readable_ref_number1",
                        "title": "On a scale of 1 to 5, what rating would you give the weather in Sydney? 1 is poor weather, 5 is excellent weather",
                        "type": "number",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "gFFf3xAkJKsr",
                        "ref": "readable_ref_legal",
                        "title": "By submitting this form, you understand and accept that we will share your answers with city management. Your answers will be anonymous will not be shared.",
                        "type": "legal",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "k6TP9oLGgHjl",
                        "ref": "readable_ref_multiple_choice",
                        "title": "Which of these cities is your favorite?",
                        "type": "multiple_choice",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "RUqkXSeXBXSd",
                        "ref": "readable_ref_yes_no",
                        "title": "Do you have a favorite city we haven't listed?",
                        "type": "yes_no",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "NRsxU591jIW9",
                        "ref": "readable_ref_opinion_scale",
                        "title": "How important is the weather to your opinion about a city? 1 is not important, 5 is very important.",
                        "type": "opinion_scale",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "WOTdC00F8A3h",
                        "ref": "readable_ref_rating",
                        "title": "How would you rate the weather where you currently live? 1 is poor weather, 5 is excellent weather.",
                        "type": "rating",
                      },
                      {
                        "allow_multiple_selections": false,
                        "allow_other_choice": false,
                        "id": "pn48RmPazVdM",
                        "ref": "readable_ref_number2",
                        "title": "On a scale of 1 to 5, what rating would you give the general quality of life in Sydney? 1 is poor, 5 is excellent",
                        "type": "number",
                      },
                      {
                        "id": "M5tXK5kG7IeA",
                        "properties": {},
                        "ref": "readable_ref_calendly",
                        "title": "Book a time with me",
                        "type": "calendly",
                      },
                    ],
                    "id": "lT4Z3j",
                    "title": "Webhooks example",
                  },
                  "ending": {
                    "id": "dN5FLyFpCMFo",
                    "ref": "01GRC8GR2017M6WW347T86VV39",
                  },
                  "form_id": "lT4Z3j",
                  "hidden": {
                    "user_id": "abc123456",
                  },
                  "landed_at": "2018-01-18T18:07:02Z",
                  "submitted_at": "2018-01-18T18:17:02Z",
                  "token": "a3a12ec67a1365927098a606107fac15",
                  "variables": [
                    {
                      "key": "score",
                      "number": 4,
                      "type": "number",
                    },
                    {
                      "key": "name",
                      "text": "typeform",
                      "type": "text",
                    },
                  ],
                },
              },
            },
          ],
          "response": {
            "headers": {},
            "status": 200,
          },
          "success": true,
        }
      `);
    } catch (e) {
      console.error(e);
      expect(true).toBe(false);
    }
  });

  test("receiving (bad signature)", async () => {
    const accessToken = authToken();

    //explicitly pass in a payload (this is hardcoded, not from a request)
    try {
      const result = await webhooks.formResponse.receive({
        credentials: {
          type: "api_key",
          name: "accessToken",
          api_key: accessToken,
          scopes: ["webhooks:write"],
        },
        secret: "123",
        subscriptionData: {
          id: "01GTH8BG8S4KK1XW38SNDN1SRV",
          form_id: "NclFXN1d",
          tag: "myTag",
          url: "https://example.com",
          enabled: true,
          verify_ssl: true,
          secret: "123456",
          created_at: "2023-03-02T13:32:00.154368Z",
          updated_at: "2023-03-02T15:08:01.697884Z",
        },
        request: {
          method: "POST",
          searchParams: new URLSearchParams(),
          headers: {
            "content-type": "application/json",
            "typeform-signature":
              "sha256=VsvwNrh0fT5VWF+05H3azXZXJyFkhHTtONMxIVm6PZ4=",
          },
          body: events.formResponse.examples[0],
          rawBody: Buffer.from(JSON.stringify(events.formResponse.examples[0])),
        },
      });

      expect(result).toMatchInlineSnapshot(`
        {
          "error": "Invalid signature",
          "response": {
            "headers": {},
            "status": 401,
          },
          "success": false,
        }
      `);
    } catch (e) {
      console.error(e);
      expect(true).toBe(false);
    }
  });

  describe("schemas", async () => {
    test("formResponse 1", async () => {
      const data = {
        event_id: "LtWXD3crgy",
        event_type: "form_response",
        form_response: {
          answers: [
            {
              field: {
                id: "DlXFaesGBpoF",
                type: "long_text",
              },
              text: "It's cold right now! I live in an older medium-sized city with a university. Geographically, the area is hilly.",
              type: "text",
            },
            {
              email: "laura@example.com",
              field: {
                id: "SMEUb7VJz92Q",
                type: "email",
              },
              type: "email",
            },
            {
              field: {
                id: "JwWggjAKtOkA",
                type: "short_text",
              },
              text: "Laura",
              type: "text",
            },
            {
              date: "2005-10-15",
              field: {
                id: "KoJxDM3c6x8h",
                type: "date",
              },
              type: "date",
            },
            {
              choices: {
                labels: ["London", "Sydney"],
              },
              field: {
                id: "PNe8ZKBK8C2Q",
                type: "picture_choice",
              },
              type: "choices",
            },
            {
              field: {
                id: "Q7M2XAwY04dW",
                type: "number",
              },
              number: 5,
              type: "number",
            },
            {
              boolean: true,
              field: {
                id: "gFFf3xAkJKsr",
                type: "legal",
              },
              type: "boolean",
            },
            {
              choice: {
                label: "London",
              },
              field: {
                id: "k6TP9oLGgHjl",
                type: "multiple_choice",
              },
              type: "choice",
            },
            {
              boolean: false,
              field: {
                id: "RUqkXSeXBXSd",
                type: "yes_no",
              },
              type: "boolean",
            },
            {
              field: {
                id: "NRsxU591jIW9",
                type: "opinion_scale",
              },
              number: 2,
              type: "number",
            },
            {
              field: {
                id: "WOTdC00F8A3h",
                type: "rating",
              },
              number: 3,
              type: "number",
            },
            {
              field: {
                id: "pn48RmPazVdM",
                type: "number",
              },
              number: 4,
              type: "number",
            },
            {
              field: {
                id: "M5tXK5kG7IeA",
                ref: "readable_ref_calendly",
                type: "calendly",
              },
              type: "url",
              url: "https://calendly.com/scheduled_events/EVENT_TYPE/invitees/INVITEE",
            },
          ],
          calculated: {
            score: 9,
          },
          definition: {
            endings: [
              {
                id: "dN5FLyFpCMFo",
                properties: {
                  button_mode: "default_redirect",
                  button_text: "Create a typeform",
                  share_icons: true,
                  show_button: true,
                },
                ref: "01GRC8GR2017M6WW347T86VV39",
                title: "Bye!",
                type: "thankyou_screen",
              },
            ],
            fields: [
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "DlXFaesGBpoF",
                ref: "readable_ref_long_text",
                title:
                  "Thanks, {{answer_60906475}}! What's it like where you live? Tell us in a few sentences.",
                type: "long_text",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "SMEUb7VJz92Q",
                ref: "readable_ref_email",
                title:
                  "If you're OK with our city management following up if they have further questions, please give us your email address.",
                type: "email",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "JwWggjAKtOkA",
                ref: "readable_ref_short_text",
                title: "What is your first name?",
                type: "short_text",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "KoJxDM3c6x8h",
                ref: "readable_ref_date",
                title: "When did you move to the place where you live?",
                type: "date",
              },
              {
                allow_multiple_selections: true,
                allow_other_choice: false,
                id: "PNe8ZKBK8C2Q",
                ref: "readable_ref_picture_choice",
                title:
                  "Which pictures do you like? You can choose as many as you like.",
                type: "picture_choice",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "Q7M2XAwY04dW",
                ref: "readable_ref_number1",
                title:
                  "On a scale of 1 to 5, what rating would you give the weather in Sydney? 1 is poor weather, 5 is excellent weather",
                type: "number",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "gFFf3xAkJKsr",
                ref: "readable_ref_legal",
                title:
                  "By submitting this form, you understand and accept that we will share your answers with city management. Your answers will be anonymous will not be shared.",
                type: "legal",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "k6TP9oLGgHjl",
                ref: "readable_ref_multiple_choice",
                title: "Which of these cities is your favorite?",
                type: "multiple_choice",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "RUqkXSeXBXSd",
                ref: "readable_ref_yes_no",
                title: "Do you have a favorite city we haven't listed?",
                type: "yes_no",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "NRsxU591jIW9",
                ref: "readable_ref_opinion_scale",
                title:
                  "How important is the weather to your opinion about a city? 1 is not important, 5 is very important.",
                type: "opinion_scale",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "WOTdC00F8A3h",
                ref: "readable_ref_rating",
                title:
                  "How would you rate the weather where you currently live? 1 is poor weather, 5 is excellent weather.",
                type: "rating",
              },
              {
                allow_multiple_selections: false,
                allow_other_choice: false,
                id: "pn48RmPazVdM",
                ref: "readable_ref_number2",
                title:
                  "On a scale of 1 to 5, what rating would you give the general quality of life in Sydney? 1 is poor, 5 is excellent",
                type: "number",
              },
              {
                id: "M5tXK5kG7IeA",
                properties: {},
                ref: "readable_ref_calendly",
                title: "Book a time with me",
                type: "calendly",
              },
            ],
            id: "lT4Z3j",
            title: "Webhooks example",
          },
          ending: {
            id: "dN5FLyFpCMFo",
            ref: "01GRC8GR2017M6WW347T86VV39",
          },
          form_id: "lT4Z3j",
          hidden: {
            user_id: "abc123456",
          },
          landed_at: "2018-01-18T18:07:02Z",
          submitted_at: "2018-01-18T18:17:02Z",
          token: "a3a12ec67a1365927098a606107fac15",
          variables: [
            {
              key: "score",
              number: 4,
              type: "number",
            },
            {
              key: "name",
              text: "typeform",
              type: "text",
            },
          ],
        },
      };

      const validationResult = await validate(data, events.formResponse.schema);
      expect(validationResult).toEqual({
        success: true,
      });
    });

    test("formResponse 2", async () => {
      const data = {
        event_id: "01GTSD5R1YKSV4DE4YH0WTHDSJ",
        event_type: "form_response",
        form_response: {
          token: "hphw0h2xjkq50gx81hphwiu6jkh43j6b",
          ending: { id: "DefaultTyScreen", ref: "default_tys" },
          answers: [
            {
              type: "number",
              field: {
                id: "w4L7U4WU7USv",
                ref: "2c62a515-ef36-438e-a4a4-222a39e2e99e",
                type: "nps",
              },
              number: 5,
            },
            {
              text: "fghhfg",
              type: "text",
              field: {
                id: "zU5ISuBXtB56",
                ref: "01E0D1GYEQKP759R4NP94X7V1D",
                type: "long_text",
              },
            },
            {
              type: "choice",
              field: {
                id: "VLghy7KPHsxX",
                ref: "01E0D1GYEQSC82ZJHD7NFF072Q",
                type: "multiple_choice",
              },
              choice: { label: "35 to 44" },
            },
            {
              type: "choice",
              field: {
                id: "AddS20Xg25Qm",
                ref: "01E0D1GYEQK8THD0P29B10ADRQ",
                type: "dropdown",
              },
              choice: { label: "Albania" },
            },
            {
              type: "choice",
              field: {
                id: "HGOZa4w1y0KA",
                ref: "01E0D1GYEQD9BB15HQM3GHTP48",
                type: "dropdown",
              },
              choice: { label: "Airlines / Aviation" },
            },
            {
              type: "choice",
              field: {
                id: "KvMvx4hBtOcV",
                ref: "01E0D1GYEQ17BCE98BZPASH3K6",
                type: "multiple_choice",
              },
              choice: { label: "51 to 200" },
            },
          ],
          form_id: "KywLXMeB",
          landed_at: "2023-03-05T17:29:54Z",
          definition: {
            id: "KywLXMeB",
            title: "Net Promoter Score® (copy)",
            fields: [
              {
                id: "w4L7U4WU7USv",
                ref: "2c62a515-ef36-438e-a4a4-222a39e2e99e",
                type: "nps",
                title:
                  "How likely are you to recommend us to a friend or colleague?",
                properties: {},
              },
              {
                id: "zU5ISuBXtB56",
                ref: "01E0D1GYEQKP759R4NP94X7V1D",
                type: "long_text",
                title: "Why did you choose ?",
                properties: {},
              },
              {
                id: "VLghy7KPHsxX",
                ref: "01E0D1GYEQSC82ZJHD7NFF072Q",
                type: "multiple_choice",
                title: "What's your age?",
                choices: [
                  { id: "SQsDGQMdaGn2", label: "Under 18" },
                  { id: "PldS57HPKq31", label: "18 to 24" },
                  { id: "h9xZWNI7wyDt", label: "25 to 34" },
                  { id: "cgDtmheGvgXA", label: "35 to 44" },
                  { id: "Xu9RKmULlXxA", label: "45 to 54" },
                  { id: "3xGelJVg6BQ3", label: "55 to 64" },
                  { id: "yO8pK25uvTED", label: "65 to 74" },
                  { id: "Y4mxwlJH0IsU", label: "75 or older" },
                ],
                properties: {},
              },
              {
                id: "AddS20Xg25Qm",
                ref: "01E0D1GYEQK8THD0P29B10ADRQ",
                type: "dropdown",
                title: "What's your country of residence?",
                choices: [
                  { id: "ggpVHxwo5xyY", label: "Afghanistan" },
                  { id: "mOP9eVTnIJCC", label: "Albania" },
                  { id: "KNOnnKx2exYM", label: "Algeria" },
                  { id: "457irbXVMAVL", label: "Andorra" },
                  { id: "5GwOYQdjunSR", label: "Angola" },
                  { id: "GgfrKlBo3rRE", label: "Antigua and Barbuda" },
                  { id: "g6MVZiPUIMdV", label: "Argentina" },
                  { id: "snLjlzg7V2FO", label: "Armenia" },
                  { id: "OwfIvcYYDQD9", label: "Aruba" },
                  { id: "KskA2KLyDNGr", label: "Australia" },
                  { id: "wQ4o0wrPUuV6", label: "Austria" },
                  { id: "Orp7HpktRv4O", label: "Azerbaijan" },
                  { id: "TFP5A8J08YxC", label: "Bahamas" },
                  { id: "BK7RXLCdYvlB", label: "Bahrain" },
                  { id: "Dtzd0fty095k", label: "Bangladesh" },
                  { id: "tbMJa4OHwMpe", label: "Barbados" },
                  { id: "AvVzIoDDPVHJ", label: "Belarus" },
                  { id: "IAXpsFx2yj09", label: "Belgium" },
                  { id: "fF5aHJmR3WS6", label: "Belize" },
                  { id: "M45AobghyYUL", label: "Benin" },
                  { id: "E66Q0BZ8iqh4", label: "Bhutan" },
                  { id: "ua2XJ0Mj0QFi", label: "Bolivia" },
                  { id: "a1BvdshzHVuU", label: "Bosnia and Herzegovina" },
                  { id: "mOqNmwmDV5bb", label: "Botswana" },
                  { id: "Do2TnRVgf1YO", label: "Brazil" },
                  { id: "FXfkCxsLSUvU", label: "Brunei" },
                  { id: "zsIw5gE2DDUH", label: "Bulgaria" },
                  { id: "XoMFygcC8MGc", label: "Burkina Faso" },
                  { id: "xPk1ogSDfO4V", label: "Burma" },
                  { id: "osLlzk1Zj3B8", label: "Burundi" },
                  { id: "dsvh9KcqcwW1", label: "Cambodia" },
                  { id: "xC8nBXYLAGRk", label: "Cameroon" },
                  { id: "GYfkjM0QJhPx", label: "Canada" },
                  { id: "bfcfNu4sGQTJ", label: "Cape Verde" },
                  { id: "u5e9EdEoaKOB", label: "Central African Republic" },
                  { id: "pA0gp2dLXVnm", label: "Chad" },
                  { id: "cldLTkwvMcnv", label: "Chile" },
                  { id: "vcS7F8eVdzst", label: "China" },
                  { id: "5pyvWuSkh3v6", label: "Colombia" },
                  { id: "L1RHnTrgnyFa", label: "Comoros" },
                  {
                    id: "XiO6zcYufsT7",
                    label: "Democratic Republic of the Congo",
                  },
                  { id: "bZQXYgBHlXkd", label: "Costa Rica" },
                  { id: "yv8sBfGnZuNn", label: "Cote d'Ivoire" },
                  { id: "QqFHSnlHa1BT", label: "Croatia" },
                  { id: "gf5mNngs9Szn", label: "Cuba" },
                  { id: "sSQmANHUeCU5", label: "Curacao" },
                  { id: "cdySLFXuAqPK", label: "Cyprus" },
                  { id: "w9ITvUlq00zk", label: "Czech Republic" },
                  { id: "DQXayFU1WOMd", label: "Denmark" },
                  { id: "915jWua5Y6UO", label: "Djibouti" },
                  { id: "FEOBwmkZh5jR", label: "Dominica" },
                  { id: "PbABWSJmsXxp", label: "Dominican Republic" },
                  { id: "Sm3isUQqRPU3", label: "East Timor" },
                  { id: "KTBj6pfJkUgT", label: "Ecuador" },
                  { id: "2kRpeiExhDMg", label: "Egypt" },
                  { id: "rkOERPwZUQ6q", label: "El Salvador" },
                  { id: "Xyoe3jrO6h7E", label: "Equatorial Guinea" },
                  { id: "maJ0pI5bdirI", label: "Eritrea" },
                  { id: "X31dYiw25wmD", label: "Estonia" },
                  { id: "9pd1nKNrQ0GL", label: "Ethiopia" },
                  { id: "DgZs5L5B2Hqi", label: "Fiji" },
                  { id: "ZZAvbCBbNAJH", label: "Finland" },
                  { id: "IuXU5KZ2VN91", label: "France" },
                  { id: "OnZSAKWaJIU8", label: "Gabon" },
                  { id: "cmHEGf3NH2sA", label: "Gambia" },
                  { id: "xDYXjww9Xtgo", label: "Georgia" },
                  { id: "NuBE9QCiSDc2", label: "Germany" },
                  { id: "RrIlTGlQRKSE", label: "Ghana" },
                  { id: "XqQ1PXOzsJUG", label: "Greece" },
                  { id: "RkMh2hl4WXh0", label: "Grenada" },
                  { id: "6oQwzPhJrj7R", label: "Guatemala" },
                  { id: "5afXBrBpRN0w", label: "Guinea" },
                  { id: "qFvl0OVqT5Or", label: "Guinea-Bissau" },
                  { id: "3tZqajnmemz0", label: "Guyana" },
                  { id: "yhpg38rY1jFJ", label: "Haiti" },
                  { id: "0H7Oa3hmtNpW", label: "Holy See" },
                  { id: "75OSvjbpTbNV", label: "Honduras" },
                  { id: "TaefzvkdvTg4", label: "Hong Kong" },
                  { id: "AeMRpGZgcyVG", label: "Hungary" },
                  { id: "KBJizGOFHAMl", label: "Iceland" },
                  { id: "DIDO3s3yBl8t", label: "India" },
                  { id: "EJ8pibBAPXGB", label: "Indonesia" },
                  { id: "sOjRUeecgUSF", label: "Iran" },
                  { id: "Hur1mJ1bmQAc", label: "Iraq" },
                  { id: "X7GjPWpIfA5w", label: "Ireland" },
                  { id: "qklzBVYmx3JQ", label: "Israel" },
                  { id: "pfKzb57zkhxz", label: "Italy" },
                  { id: "PeMKcsNVsE67", label: "Jamaica" },
                  { id: "dtLFo2hjuayU", label: "Japan" },
                  { id: "M7rMlJaKyepP", label: "Jordan" },
                  { id: "5w05kNWyDhSk", label: "Kazakhstan" },
                  { id: "jb3Or7SlMrEL", label: "Kenya" },
                  { id: "0vGWD1l9eyRC", label: "Kiribati" },
                  { id: "hRmyNAMQg7Wx", label: "Kosovo" },
                  { id: "EAWjwqRsXpUN", label: "Kuwait" },
                  { id: "AKydA2diOPJ9", label: "Kyrgyzstan" },
                  { id: "Y3BwdRzjzg4w", label: "Laos" },
                  { id: "azcPEY3tw8zB", label: "Latvia" },
                  { id: "iaDA1gcwvLok", label: "Lebanon" },
                  { id: "99NiMd7U6MNH", label: "Lesotho" },
                  { id: "0kvw7ftffYNV", label: "Liberia" },
                  { id: "71pMBrCicOjj", label: "Libya" },
                  { id: "gzamHsfQuqHJ", label: "Liechtenstein" },
                  { id: "wusYAZJ9AOPU", label: "Lithuania" },
                  { id: "3TT3T1ctU7cu", label: "Luxembourg" },
                  { id: "iKKZEARJNWnH", label: "Macau" },
                  { id: "pwYlUwiMDsMn", label: "Macedonia" },
                  { id: "SJ4LJtOUhi8T", label: "Madagascar" },
                  { id: "0lV7E5J5BjL2", label: "Malawi" },
                  { id: "D3hxSqJ3ecGI", label: "Malaysia" },
                  { id: "MD9vfEtORl5I", label: "Maldives" },
                  { id: "lm0qiEoUyWJQ", label: "Mali" },
                  { id: "pY1svv8Wmmik", label: "Malta" },
                  { id: "Vyxcknp5FxkZ", label: "Marshall Islands" },
                  { id: "Et2OIYo09lFh", label: "Mauritania" },
                  { id: "TTFv8wWUGxrL", label: "Mauritius" },
                  { id: "V700pfY1WmiR", label: "Mexico" },
                  { id: "yOSMmEdLCCuv", label: "Micronesia" },
                  { id: "gsu3MFEl8w3Y", label: "Moldova" },
                  { id: "cTaKbfzMbd4E", label: "Monaco" },
                  { id: "ilsmf1EByAby", label: "Mongolia" },
                  { id: "mjyCLTqOBBzD", label: "Montenegro" },
                  { id: "45QMORuJSJqs", label: "Morocco" },
                  { id: "UPKZfXtHAtL4", label: "Mozambique" },
                  { id: "6JGAFZWk2F0c", label: "Namibia" },
                  { id: "RAzzAwKCHVWV", label: "Nauru" },
                  { id: "VLIdG7FehvOA", label: "Nepal" },
                  { id: "nfkjJlekuBL5", label: "Netherlands" },
                  { id: "ZX4R5DSFr0JB", label: "Netherlands Antilles" },
                  { id: "vD0epxjGd9mx", label: "New Zealand" },
                  { id: "MEwOvWXLx3oY", label: "Nicaragua" },
                  { id: "L4h3KmLJH7jS", label: "Niger" },
                  { id: "jPUbeuiEYe0b", label: "Nigeria" },
                  { id: "uPlyhEafOdQp", label: "North Korea" },
                  { id: "WFyflJIL33Fj", label: "Norway" },
                  { id: "YjjYDLM8FqUF", label: "Oman" },
                  { id: "EncJ3TVvCLQv", label: "Pakistan" },
                  { id: "vBSEk4bamECF", label: "Palau" },
                  { id: "AxxDvya6pDlt", label: "Palestinian Territories" },
                  { id: "WCeodSquLgpb", label: "Panama" },
                  { id: "ataYnxT13TvK", label: "Papua New Guinea" },
                  { id: "J2jKGUzmjf4S", label: "Paraguay" },
                  { id: "VcwyY6ff1u7d", label: "Peru" },
                  { id: "EVmEBkD5Xix2", label: "Philippines" },
                  { id: "iF5y1bW1v8hm", label: "Poland" },
                  { id: "v40zNHMaqbr7", label: "Portugal" },
                  { id: "VvuFo8NEWwHr", label: "Qatar" },
                  { id: "88CwuIlqIV7Y", label: "Romania" },
                  { id: "lxh51YkksSoN", label: "Russia" },
                  { id: "np8fMzz33Dok", label: "Rwanda" },
                  { id: "ZIlLXuzLa5n0", label: "Saint Kitts and Nevis" },
                  { id: "PLf7ZfXhuHmh", label: "Saint Lucia" },
                  {
                    id: "H2esyJBCWQ66",
                    label: "Saint Vincent and the Grenadines",
                  },
                  { id: "e0srYwLU8IsT", label: "Samoa" },
                  { id: "dYfyeFXfqgne", label: "San Marino" },
                  { id: "y25FmWFP3iVv", label: "Sao Tome and Principe" },
                  { id: "NLCwpMSpZmio", label: "Saudi Arabia" },
                  { id: "qO9XHeoBSRni", label: "Senegal" },
                  { id: "o5zx2a2buPSe", label: "Serbia" },
                  { id: "vV3nsJDxtDoU", label: "Seychelles" },
                  { id: "LCNpig2cPPRY", label: "Sierra Leone" },
                  { id: "eXHNHTIlWwlR", label: "Singapore" },
                  { id: "qVlfEHaLx4wk", label: "Sint Maarten" },
                  { id: "j1mHj03aq7cA", label: "Slovakia" },
                  { id: "0capewNWlzMn", label: "Slovenia" },
                  { id: "Eaanmrqauymz", label: "Solomon Islands" },
                  { id: "pQfkoAzDEra2", label: "Somalia" },
                  { id: "ymlXBNG9kQ45", label: "South Africa" },
                  { id: "VZMvFMKde19O", label: "South Korea" },
                  { id: "N9x58Op8Y57d", label: "South Sudan" },
                  { id: "c5EmR4eZ0wuC", label: "Spain" },
                  { id: "piVS3FMOVDKT", label: "Sri Lanka" },
                  { id: "epQb60K5Af7c", label: "Sudan" },
                  { id: "1vHyzuFIvA8q", label: "Suriname" },
                  { id: "GuWeqIDLSFRK", label: "Swaziland" },
                  { id: "slJUXW371ZF9", label: "Sweden" },
                  { id: "HvFLKGb0BruO", label: "Switzerland" },
                  { id: "hMLZFBhUCWbj", label: "Syria" },
                  { id: "WlEH0Xc5b6QP", label: "Taiwan" },
                  { id: "AjkPdFBfoUrg", label: "Tajikistan" },
                  { id: "i14Hxyqtsrwb", label: "Tanzania" },
                  { id: "gMzxmmeYfNRs", label: "Thailand" },
                  { id: "OAtKqjECvKJi", label: "Togo" },
                  { id: "i2pUEWLq2Pg7", label: "Tonga" },
                  { id: "u6cZtgnU4bXf", label: "Trinidad and Tobago" },
                  { id: "0xUYURCIqgsb", label: "Tunisia" },
                  { id: "ciTWM7yCnAJ0", label: "Turkey" },
                  { id: "EALLOUAoWToz", label: "Turkmenistan" },
                  { id: "0yfWs9vbLJm6", label: "Tuvalu" },
                  { id: "Wp47o77MuFlH", label: "Uganda" },
                  { id: "1wduuBAdGHpv", label: "Ukraine" },
                  { id: "0faSCuoqHr5d", label: "United Arab Emirates" },
                  { id: "Xur3acA5TU9L", label: "United Kingdom" },
                  { id: "lvQrSWcgW31q", label: "United States of America" },
                  { id: "GRfsHMa5nQs2", label: "Uruguay" },
                  { id: "Wrkp5dvgu18A", label: "Uzbekistan" },
                  { id: "imCoEDqhKcS4", label: "Vanuatu" },
                  { id: "aDaPDPlWAsTJ", label: "Venezuela" },
                  { id: "qn70yN7yXmng", label: "Vietnam" },
                  { id: "hBnBHj91cw6J", label: "Yemen" },
                  { id: "gZm8uBgeQ2lN", label: "Zambia" },
                  { id: "sABMpOSW32x1", label: "Zimbabwe" },
                ],
                properties: {},
              },
              {
                id: "HGOZa4w1y0KA",
                ref: "01E0D1GYEQD9BB15HQM3GHTP48",
                type: "dropdown",
                title: "Which industry do you work in?",
                choices: [
                  { id: "77lPtDHFiOzB", label: "Accounting" },
                  { id: "KX8Kme95lkS6", label: "Airlines / Aviation" },
                  {
                    id: "EIyBdznqN1Gw",
                    label: "Alternative Dispute Resolution",
                  },
                  { id: "e84axRfJwxq8", label: "Alternative Medicine" },
                  { id: "5fuLx4qlpNPk", label: "Animation" },
                  { id: "1n6J5yJJzcse", label: "Apparel & Fashion" },
                  { id: "PnN0H8tdTB80", label: "Architecture & Planning" },
                  { id: "D34NLCmd23YZ", label: "Arts & Crafts" },
                  { id: "lYITB5VoOIcF", label: "Automotive" },
                  { id: "H5NC4pjcbCqV", label: "Aviation & Aerospace" },
                  { id: "2gFWS40gDg1A", label: "Banking" },
                  { id: "54GpagRojhHs", label: "Biotechnology" },
                  { id: "ZwG1VhxHNjst", label: "Broadcast Media" },
                  { id: "9pAePnDgsiw1", label: "Building Materials" },
                  {
                    id: "4cnAiFIKDufn",
                    label: "Business Supplies & Equipment",
                  },
                  { id: "AXEa04WRZI8r", label: "Capital Markets" },
                  { id: "XWuVYl07gv3O", label: "Chemicals" },
                  { id: "bEwdkJHDML1x", label: "Civic & Social Organization" },
                  { id: "M7kxd79NpPo9", label: "Civil Engineering" },
                  { id: "YJl3aVWCQjiN", label: "Commercial Real Estate" },
                  { id: "pkvJ75nOYtez", label: "Computer & Network Security" },
                  { id: "j0oQIfxom25I", label: "Computer Games" },
                  { id: "s9gvhKjKl7NF", label: "Computer Hardware" },
                  { id: "NMTGWsKzo4gm", label: "Computer Networking" },
                  { id: "6WmYi5g83Kvx", label: "Computer Software" },
                  { id: "MDRi2eq5efa6", label: "Construction" },
                  { id: "7GjU5OcS2aD3", label: "Consumer Electronics" },
                  { id: "jOvy0iZ8LH1l", label: "Consumer Goods" },
                  { id: "XSyoiJHLzQvS", label: "Consumer Services" },
                  { id: "6bNIAAJGHpa1", label: "Cosmetics" },
                  { id: "gEUe3ZwU4uZH", label: "Dairy" },
                  { id: "615eY7EoT3OG", label: "Defense & Space" },
                  { id: "vX4yklDQXKYd", label: "Design" },
                  { id: "3XMkqTwR010U", label: "Education Management" },
                  { id: "tUqTNp80txlK", label: "E-Learning" },
                  {
                    id: "WbKX6hdmikja",
                    label: "Electrical / Electronic Manufacturing",
                  },
                  { id: "kWq8zLpPXGWr", label: "Entertainment" },
                  { id: "3zdElcaTLqmO", label: "Environmental Services" },
                  { id: "OncO5lcBVRQZ", label: "Events Services" },
                  { id: "Glob2ZFgGlqI", label: "Executive Office" },
                  { id: "Xm0uvRO2LaCV", label: "Facilities Services" },
                  { id: "Ol75oYMO79Iv", label: "Farming" },
                  { id: "UO6ohgvOipmx", label: "Financial Services" },
                  { id: "TimuH2bxqtxR", label: "Fine Art" },
                  { id: "2C8avtFKfKgZ", label: "Fishery" },
                  { id: "YfFbdsRqFfAy", label: "Food & Beverages" },
                  { id: "DfeP1p9yQK8J", label: "Food Production" },
                  { id: "ZGUWXE62lOvf", label: "Fund-Raising" },
                  { id: "X1ZMol7KUWiT", label: "Furniture" },
                  { id: "Ke7yN9v817OJ", label: "Gambling & Casinos" },
                  { id: "TWr7lQ63TtqR", label: "Glass, Ceramics & Concrete" },
                  { id: "s5KwhlZXQZ5U", label: "Government Administration" },
                  { id: "BgwNUDeFX5dl", label: "Government Relations" },
                  { id: "Y0DwYfctqkox", label: "Graphic Design" },
                  { id: "mqX4N97ZzYGp", label: "Health, Wellness & Fitness" },
                  { id: "ojcG3WKf9av0", label: "Higher Education" },
                  { id: "0iPTcSwStPZR", label: "Hospital & Health Care" },
                  { id: "JsRJNwBz3lLr", label: "Hospitality" },
                  { id: "D1UM3Rf5qKUv", label: "Human Resources" },
                  { id: "YDIlUGJwrCsV", label: "Import & Export" },
                  { id: "BkvHblIr6YuV", label: "Individual & Family Services" },
                  { id: "NVqagPACTmu4", label: "Industrial Automation" },
                  { id: "f3knBiVcAXSe", label: "Information Services" },
                  {
                    id: "D3Aoe6Aurir2",
                    label: "Information Technology & Services",
                  },
                  { id: "Gc5Epj3X6KA7", label: "Insurance" },
                  { id: "grB5kmdsQYq0", label: "International Affairs" },
                  {
                    id: "YTGDn3WbKltc",
                    label: "International Trade & Development",
                  },
                  { id: "Dw9bWINQWTaP", label: "Internet" },
                  { id: "e18g5yqMuBej", label: "Investment Banking" },
                  { id: "hS3hgRf2YQPi", label: "Investment Management" },
                  { id: "LlZWE1u749ZK", label: "Judiciary" },
                  { id: "jsH5mWxEAhtK", label: "Law Enforcement" },
                  { id: "iLqzLB8ZRgzA", label: "Law Practice" },
                  { id: "1TVvDiHJCaIj", label: "Legal Services" },
                  { id: "X4p2nuvWW8N6", label: "Legislative Office" },
                  { id: "PWMMKGTwJoRw", label: "Leisure, Travel & Tourism" },
                  { id: "89gZFc6LHyZ5", label: "Libraries" },
                  { id: "WkHt2RG6Jl3X", label: "Logistics & Supply Chain" },
                  { id: "hBFJmaZswc9n", label: "Luxury Goods & Jewelry" },
                  { id: "hjCMl5N8afHM", label: "Machinery" },
                  { id: "VbV1uW52jmny", label: "Management Consulting" },
                  { id: "xhlgTG3dYPMb", label: "Maritime" },
                  { id: "16vkJZrkXlca", label: "Market Research" },
                  { id: "qZGO9vzmNPq2", label: "Marketing & Advertising" },
                  {
                    id: "rHm0Nt3uZl7F",
                    label: "Mechanical or Industrial Engineering",
                  },
                  { id: "OwP4JeBr0j0G", label: "Media Production" },
                  { id: "miMRHxk0l959", label: "Medical Devices" },
                  { id: "Hhn53Eclnas6", label: "Medical Practice" },
                  { id: "BMagEysbHmMK", label: "Mental Health Care" },
                  { id: "u7lU7MTxsunj", label: "Military" },
                  { id: "WfRuLtRj7BKP", label: "Mining & Metals" },
                  { id: "tc01goGeJFVW", label: "Motion Pictures & Film" },
                  { id: "bBYBSyukCAFY", label: "Museums & Institutions" },
                  { id: "6yR1VeBfFhEh", label: "Music" },
                  { id: "fuoMnv0V0nMT", label: "Nanotechnology" },
                  { id: "rDcUbjtUm5yv", label: "Newspapers" },
                  {
                    id: "aHKguzWt7l0K",
                    label: "Non-Profit Organization Management",
                  },
                  { id: "t3ZEhGezG7Z3", label: "Oil & Energy" },
                  { id: "WcbW8j48MxMT", label: "Online Media" },
                  { id: "Tpdw3tCpKAsK", label: "Outsourcing / Offshoring" },
                  { id: "5fBlSGSpjVEo", label: "Package / Freight Delivery" },
                  { id: "uQNe1hNahQCB", label: "Packaging & Containers" },
                  { id: "lIFZqYG6cUxq", label: "Paper & Forest Products" },
                  { id: "TUboFmLiI4fV", label: "Performing Arts" },
                  { id: "uxvAp7acAWCK", label: "Pharmaceuticals" },
                  { id: "0IZadLrSljxJ", label: "Philanthropy" },
                  { id: "J3xo4a1qXYIx", label: "Photography" },
                  { id: "Vqsx9VF52ZOh", label: "Plastics" },
                  { id: "A7vMqTFmkSKF", label: "Political Organization" },
                  {
                    id: "tfnLrZhqcvoW",
                    label: "Primary / Secondary Education",
                  },
                  { id: "SDnZiz1dQXuz", label: "Printing" },
                  {
                    id: "TtfgJ7RpkdHu",
                    label: "Professional Training & Coaching",
                  },
                  { id: "k5SJTP7RmrNh", label: "Program Development" },
                  { id: "X63sl3HMjPyj", label: "Public Policy" },
                  {
                    id: "5GrlMfOFNzS2",
                    label: "Public Relations & Communications",
                  },
                  { id: "ZOBYjPzQhqoR", label: "Public Safety" },
                  { id: "To7iwxoFrHt2", label: "Publishing" },
                  { id: "rrsI1xfb0KAA", label: "Railroad Manufacture" },
                  { id: "7fOAZo2pinlk", label: "Ranching" },
                  { id: "LVLKDGbCYEBG", label: "Real Estate" },
                  {
                    id: "3qSlgYAnDkrA",
                    label: "Recreational Facilities & Services",
                  },
                  { id: "jpTqr5Nkura9", label: "Religious Institutions" },
                  { id: "jI33Ui8fMR5O", label: "Renewables & Environment" },
                  { id: "F1JLKQA8txk0", label: "Research" },
                  { id: "mCegzlG9vO6i", label: "Restaurants" },
                  { id: "zO2BvtMerVjf", label: "Retail" },
                  { id: "ofW7YoOUSrCC", label: "Security & Investigations" },
                  { id: "4Haufz0JrTDE", label: "Semiconductors" },
                  { id: "N736YR9XCjmr", label: "Shipbuilding" },
                  { id: "rT2McpSoy9xW", label: "Sporting Goods" },
                  { id: "eUUVflIOrpq8", label: "Sports" },
                  { id: "rlOHaqkctWFN", label: "Staffing & Recruiting" },
                  { id: "EJa1VQzU6JYe", label: "Supermarkets" },
                  { id: "JcU4vLD0iwFZ", label: "Telecommunications" },
                  { id: "Bwf7wu42B9K6", label: "Textiles" },
                  { id: "NoNKVyUKPoDy", label: "Think Tanks" },
                  { id: "YpkOGvOfOYzT", label: "Tobacco" },
                  { id: "B3HgG19r8Gnm", label: "Translation & Localization" },
                  {
                    id: "LGKGVHIqZdzl",
                    label: "Transportation / Trucking / Railroad",
                  },
                  { id: "QYKm7bOiYdpM", label: "Utilities" },
                  {
                    id: "lyFfiqHrW6sM",
                    label: "Venture Capital & Private Equity",
                  },
                  { id: "l54TIxHhz7KG", label: "Veterinary" },
                  { id: "UN9mqjfN48EA", label: "Warehousing" },
                  { id: "3Ev9drZtCCqr", label: "Wholesale" },
                  { id: "K90mh5ZHv2Tn", label: "Wine & Spirits" },
                  { id: "Oxp0WyLxlufQ", label: "Wireless" },
                  { id: "UjXQa2oSLSz4", label: "Writing & Editing" },
                ],
                properties: {},
              },
              {
                id: "KvMvx4hBtOcV",
                ref: "01E0D1GYEQ17BCE98BZPASH3K6",
                type: "multiple_choice",
                title: "How many employees does your organization have?",
                choices: [
                  { id: "Z6TiX8WFahlL", label: "It's just me :)" },
                  { id: "lJahxmsyIRN4", label: "2 to 10" },
                  { id: "PzrS0m4d6kUb", label: "11 to 50" },
                  { id: "FC2uIYYNxVT9", label: "51 to 200" },
                  { id: "z15fSBWwILmr", label: "500 or more" },
                ],
                properties: {},
              },
            ],
            endings: [
              {
                id: "DefaultTyScreen",
                ref: "default_tys",
                type: "thankyou_screen",
                title:
                  "Thanks for completing this typeform\nNow *create your own* — it's free, easy, & beautiful",
                attachment: {
                  href: "https://images.typeform.com/images/2dpnUBBkz2VN",
                  type: "image",
                },
                properties: {
                  button_mode: "default_redirect",
                  button_text: "Create a *typeform*",
                  share_icons: false,
                  show_button: true,
                },
              },
            ],
          },
          submitted_at: "2023-03-05T17:30:09Z",
        },
      };

      const validationResult = await validate(data, events.formResponse.schema);
      expect(validationResult).toEqual({
        success: true,
      });
    });
  });
});
