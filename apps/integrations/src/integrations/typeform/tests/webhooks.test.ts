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
});
