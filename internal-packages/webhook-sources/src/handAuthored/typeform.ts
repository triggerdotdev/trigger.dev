import { type SampleRecord } from "../sampleRecord.js";

/**
 * Typeform samples. Typeform has a single webhook event, `form_response`, fired whenever a respondent
 * completes a form; these vary the form shape (field types, hidden fields, calculated score) to cover
 * the range of `definition.fields` / `answers` combinations integrators actually see. Typeform signs
 * with a `Typeform-Signature: sha256=<base64>` header over the raw body, which doesn't match any of our
 * verifier presets, so no `presetId` is set.
 */
export const samples: SampleRecord[] = [
  {
    provider: "typeform",
    providerLabel: "Typeform",
    eventType: "form_response",
    name: "Contact form submission",
    description: "A respondent completed a basic contact form (name, email, message).",
    body: {
      event_id: "01HXQ3ZK9BCONTACT01",
      event_type: "form_response",
      form_response: {
        form_id: "A1b2C3",
        token: "6f3e8a1c9d2b47a0b6e5f1a2c3d4e5f6",
        response_id: "6f3e8a1c9d2b47a0b6e5f1a2c3d4e5f6",
        response_url:
          "https://admin.typeform.com/form/A1b2C3/results?responseId=6f3e8a1c9d2b47a0b6e5f1a2c3d4e5f6",
        landed_at: "2026-07-08T14:02:11Z",
        submitted_at: "2026-07-08T14:04:47Z",
        hidden: {
          utm_source: "newsletter",
        },
        definition: {
          id: "A1b2C3",
          title: "Contact us",
          fields: [
            {
              id: "JwWggjAKtOk1",
              title: "What's your full name?",
              type: "short_text",
              ref: "full_name",
            },
            {
              id: "JwWggjAKtOk2",
              title: "What's your email address?",
              type: "email",
              ref: "email",
            },
            { id: "JwWggjAKtOk3", title: "How can we help?", type: "long_text", ref: "message" },
          ],
        },
        answers: [
          {
            type: "text",
            text: "Priya Nair",
            field: { id: "JwWggjAKtOk1", type: "short_text", ref: "full_name" },
          },
          {
            type: "email",
            email: "priya.nair@example.com",
            field: { id: "JwWggjAKtOk2", type: "email", ref: "email" },
          },
          {
            type: "text",
            text: "Hi, I'd like a quote for the annual plan for a 40-person team.",
            field: { id: "JwWggjAKtOk3", type: "long_text", ref: "message" },
          },
        ],
      },
    },
    docsUrl: "https://www.typeform.com/developers/webhooks/secure-your-webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "typeform",
    providerLabel: "Typeform",
    eventType: "form_response",
    name: "Customer satisfaction survey",
    description:
      "A CSAT/NPS survey response with a scored opinion-scale answer; `calculated.score` reflects the form's scoring configuration.",
    body: {
      event_id: "01HXQ3ZK9BCSAT0001",
      event_type: "form_response",
      form_response: {
        form_id: "D4e5F6",
        token: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
        response_id: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
        response_url:
          "https://admin.typeform.com/form/D4e5F6/results?responseId=9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
        landed_at: "2026-07-09T09:11:02Z",
        submitted_at: "2026-07-09T09:12:30Z",
        calculated: {
          score: 9,
        },
        hidden: {
          user_id: "cus_9f8e7d6c5b4a",
          plan: "growth",
        },
        definition: {
          id: "D4e5F6",
          title: "How are we doing?",
          fields: [
            {
              id: "Q7M2XAwY04d1",
              title: "How likely are you to recommend us to a friend?",
              type: "opinion_scale",
              ref: "nps_score",
            },
            {
              id: "Q7M2XAwY04d2",
              title: "Anything you'd like us to improve?",
              type: "long_text",
              ref: "improve_feedback",
            },
          ],
        },
        answers: [
          {
            type: "number",
            number: 9,
            field: { id: "Q7M2XAwY04d1", type: "opinion_scale", ref: "nps_score" },
          },
          {
            type: "text",
            text: "The mobile app could load a bit faster on older devices.",
            field: { id: "Q7M2XAwY04d2", type: "long_text", ref: "improve_feedback" },
          },
        ],
      },
    },
    docsUrl: "https://www.typeform.com/developers/webhooks/secure-your-webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "typeform",
    providerLabel: "Typeform",
    eventType: "form_response",
    name: "Job application",
    description:
      "A job application with a phone number, a file upload, and a single-choice referral field.",
    body: {
      event_id: "01HXQ3ZK9BJOB00001",
      event_type: "form_response",
      form_response: {
        form_id: "G7h8I9",
        token: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
        response_id: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
        response_url:
          "https://admin.typeform.com/form/G7h8I9/results?responseId=1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
        landed_at: "2026-07-10T16:40:05Z",
        submitted_at: "2026-07-10T16:48:22Z",
        hidden: {
          req_id: "req_284910",
        },
        definition: {
          id: "G7h8I9",
          title: "Senior Support Engineer application",
          fields: [
            { id: "KpNvQ2rTsUx1", title: "Full name", type: "short_text", ref: "full_name" },
            { id: "KpNvQ2rTsUx2", title: "Phone number", type: "phone_number", ref: "phone" },
            { id: "KpNvQ2rTsUx3", title: "Upload your resume", type: "file_upload", ref: "resume" },
            {
              id: "KpNvQ2rTsUx4",
              title: "How did you hear about us?",
              type: "multiple_choice",
              ref: "referral_source",
            },
          ],
        },
        answers: [
          {
            type: "text",
            text: "Sam Okafor",
            field: { id: "KpNvQ2rTsUx1", type: "short_text", ref: "full_name" },
          },
          {
            type: "phone_number",
            phone_number: "+15551234567",
            field: { id: "KpNvQ2rTsUx2", type: "phone_number", ref: "phone" },
          },
          {
            type: "file_url",
            file_url:
              "https://api.typeform.com/forms/G7h8I9/responses/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/files/KpNvQ2rTsUx3/0/samokafor-resume.pdf",
            field: { id: "KpNvQ2rTsUx3", type: "file_upload", ref: "resume" },
          },
          {
            type: "choice",
            choice: { label: "LinkedIn" },
            field: { id: "KpNvQ2rTsUx4", type: "multiple_choice", ref: "referral_source" },
          },
        ],
      },
    },
    docsUrl: "https://www.typeform.com/developers/webhooks/secure-your-webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "typeform",
    providerLabel: "Typeform",
    eventType: "form_response",
    name: "Event registration",
    description:
      "An event RSVP with a single-choice ticket field, a multi-select dietary field, and a legal consent checkbox.",
    body: {
      event_id: "01HXQ3ZK9BEVT00001",
      event_type: "form_response",
      form_response: {
        form_id: "J1k2L3",
        token: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        response_id: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        response_url:
          "https://admin.typeform.com/form/J1k2L3/results?responseId=5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        landed_at: "2026-07-11T11:03:44Z",
        submitted_at: "2026-07-11T11:06:19Z",
        hidden: {
          campaign: "summit-2026",
        },
        definition: {
          id: "J1k2L3",
          title: "Register for the 2026 Summit",
          fields: [
            {
              id: "MqRwT4vXyZa1",
              title: "Ticket type",
              type: "multiple_choice",
              ref: "ticket_type",
            },
            {
              id: "MqRwT4vXyZa2",
              title: "Any dietary restrictions?",
              type: "multiple_choice",
              ref: "dietary_restrictions",
            },
            {
              id: "MqRwT4vXyZa3",
              title: "I agree to the event terms",
              type: "legal",
              ref: "agree_terms",
            },
          ],
        },
        answers: [
          {
            type: "choice",
            choice: { label: "General admission" },
            field: { id: "MqRwT4vXyZa1", type: "multiple_choice", ref: "ticket_type" },
          },
          {
            type: "choices",
            choices: { labels: ["Vegetarian", "Nut allergy"] },
            field: { id: "MqRwT4vXyZa2", type: "multiple_choice", ref: "dietary_restrictions" },
          },
          {
            type: "boolean",
            boolean: true,
            field: { id: "MqRwT4vXyZa3", type: "legal", ref: "agree_terms" },
          },
        ],
      },
    },
    docsUrl: "https://www.typeform.com/developers/webhooks/secure-your-webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "typeform",
    providerLabel: "Typeform",
    eventType: "form_response",
    name: "Product waitlist signup",
    description:
      "A waitlist signup with an email, a dropdown for company size, and a target-launch date.",
    body: {
      event_id: "01HXQ3ZK9BWAIT0001",
      event_type: "form_response",
      form_response: {
        form_id: "N4o5P6",
        token: "3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
        response_id: "3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
        response_url:
          "https://admin.typeform.com/form/N4o5P6/results?responseId=3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
        landed_at: "2026-07-12T08:20:00Z",
        submitted_at: "2026-07-12T08:21:15Z",
        hidden: {
          utm_source: "product-hunt",
          utm_campaign: "launch-waitlist",
        },
        definition: {
          id: "N4o5P6",
          title: "Join the waitlist",
          fields: [
            { id: "RtYuI7oPaSd1", title: "Work email", type: "email", ref: "work_email" },
            { id: "RtYuI7oPaSd2", title: "Company size", type: "dropdown", ref: "company_size" },
            {
              id: "RtYuI7oPaSd3",
              title: "When do you want to launch?",
              type: "date",
              ref: "target_launch_date",
            },
          ],
        },
        answers: [
          {
            type: "email",
            email: "jordan.lee@example.com",
            field: { id: "RtYuI7oPaSd1", type: "email", ref: "work_email" },
          },
          {
            type: "choice",
            choice: { label: "11-50" },
            field: { id: "RtYuI7oPaSd2", type: "dropdown", ref: "company_size" },
          },
          {
            type: "date",
            date: "2026-09-01",
            field: { id: "RtYuI7oPaSd3", type: "date", ref: "target_launch_date" },
          },
        ],
      },
    },
    docsUrl: "https://www.typeform.com/developers/webhooks/secure-your-webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
