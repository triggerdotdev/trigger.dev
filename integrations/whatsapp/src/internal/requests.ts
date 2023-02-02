import { HttpEndpoint, HttpService } from "@trigger.dev/integration-sdk";
import type {
  DisplayProperties,
  CacheService,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
  AccessInfo,
} from "@trigger.dev/integration-sdk";
import debug from "debug";
import { getAccessToken } from "@trigger.dev/integration-sdk";
import { z } from "zod";
import {
  SendTemplateMessageBodySchema,
  SendTemplateMessageRequestBodySchema,
  SendTextMessageBodySchema,
  SendTextMessageRequestBodySchema,
  SendReactionMessageBodySchema,
  SendReactionMessageRequestBodySchema,
  SendImageMessageBodySchema,
  SendImageMessageRequestBodySchema,
  SendLocationMessageRequestBodySchema,
  SendLocationMessageBodySchema,
  SendContactsMessageRequestBodySchema,
  SendContactsMessageBodySchema,
  SendMessageResponseSchema,
  SendAudioMessageRequestBodySchema,
  SendVideoMessageRequestBodySchema,
  SendDocumentMessageRequestBodySchema,
  SendStickerMessageRequestBodySchema,
  SendAudioMessageBodySchema,
  SendVideoMessageBodySchema,
  SendDocumentMessageBodySchema,
  SendStickerMessageBodySchema,
} from "../schemas/messages";
import { EventMediaObjectSchema } from "../schemas/messageEvents";

const log = debug("trigger:integrations:whatsapp");

type SendTemplateMessageRequestBody = z.infer<
  typeof SendTemplateMessageRequestBodySchema
>;

type SendTextMessageRequestBody = z.infer<
  typeof SendTextMessageRequestBodySchema
>;

type SendReactionMessageRequestBody = z.infer<
  typeof SendReactionMessageRequestBodySchema
>;

type SendImageMessageRequestBody = z.infer<
  typeof SendImageMessageRequestBodySchema
>;

type SendAudioMessageRequestBody = z.infer<
  typeof SendAudioMessageRequestBodySchema
>;

type SendVideoMessageRequestBody = z.infer<
  typeof SendVideoMessageRequestBodySchema
>;

type SendDocumentMessageRequestBody = z.infer<
  typeof SendDocumentMessageRequestBodySchema
>;

type SendStickerMessageRequestBody = z.infer<
  typeof SendStickerMessageRequestBodySchema
>;

type SendLocationMessageRequestBody = z.infer<
  typeof SendLocationMessageRequestBodySchema
>;

type SendContactsMessageRequestBody = z.infer<
  typeof SendContactsMessageRequestBodySchema
>;

export class WhatsAppRequestIntegration implements RequestIntegration {
  #sendTemplateMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendTemplateMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendTextMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendTextMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendReactionMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendReactionMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendImageMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendImageMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendAudioMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendAudioMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendVideoMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendVideoMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendDocumentMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendDocumentMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendStickerMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendStickerMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendLocationMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendLocationMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendContactsMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendContactsMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  constructor(
    private readonly baseUrl: string = "https://graph.facebook.com/v15.0"
  ) {}

  perform(options: PerformRequestOptions): Promise<PerformedRequestResponse> {
    switch (options.endpoint) {
      case "message.sendTemplate": {
        return this.#sendTemplateMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendText": {
        return this.#sendTextMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendReaction": {
        return this.#sendReactionMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendImage": {
        return this.#sendImageMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendAudio": {
        return this.#sendAudioMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendVideo": {
        return this.#sendVideoMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendDocument": {
        return this.#sendDocumentMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendSticker": {
        return this.#sendStickerMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendLocation": {
        return this.#sendLocationMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendContacts": {
        return this.#sendContactsMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "media.getUrl": {
        return this.#getMediaUrl(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      default: {
        throw new Error(`Unknown endpoint: ${options.endpoint}`);
      }
    }
  }

  displayProperties(endpoint: string, params: any): DisplayProperties {
    switch (endpoint) {
      case "message.sendTemplate": {
        const parsedParams = SendTemplateMessageBodySchema.parse(params);
        return {
          title: `Send template (${parsedParams.template}) to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendText": {
        const parsedParams = SendTextMessageBodySchema.parse(params);
        return {
          title: `Send text to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendReaction": {
        const parsedParams = SendReactionMessageBodySchema.parse(params);
        return {
          title: `Send ${parsedParams.emoji} reaction to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendImage": {
        const parsedParams = SendImageMessageBodySchema.parse(params);
        return {
          title: `Send image (${parsedParams.url}) to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendAudio": {
        const parsedParams = SendAudioMessageBodySchema.parse(params);
        return {
          title: `Send audio (${parsedParams.url}) to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendVideo": {
        const parsedParams = SendVideoMessageBodySchema.parse(params);
        return {
          title: `Send video (${parsedParams.url}) to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendDocument": {
        const parsedParams = SendDocumentMessageBodySchema.parse(params);
        return {
          title: `Send document (${parsedParams.url}) to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendSticker": {
        const parsedParams = SendStickerMessageBodySchema.parse(params);
        return {
          title: `Send sticker (${parsedParams.url}) to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendLocation": {
        const parsedParams = SendLocationMessageBodySchema.parse(params);
        return {
          title: `Send location to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendContacts": {
        const parsedParams = SendContactsMessageBodySchema.parse(params);
        return {
          title: `Send contacts to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "media.getUrl": {
        const parsedParams = EventMediaObjectSchema.parse(params);
        return {
          title: `Get media URL for id ${parsedParams.id}`,
          properties: [],
        };
      }
      default: {
        throw new Error(`Unknown endpoint: ${endpoint}`);
      }
    }
  }

  async #sendTemplateMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendTemplateMessageBodySchema.parse(params);

    log("message.sendTemplate %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const components: SendTemplateMessageRequestBody["template"]["components"] =
      [];

    if (parsedParams.parameters?.header) {
      components.push({
        type: "header",
        parameters: parsedParams.parameters.header,
      });
    }

    if (parsedParams.parameters?.body) {
      components.push({
        type: "body",
        parameters: parsedParams.parameters.body,
      });
    }

    if (parsedParams.parameters?.buttons) {
      parsedParams.parameters.buttons.forEach((button, index) => {
        components.push({
          type: "button",
          sub_type: button.sub_type,
          index: index,
          parameters: button.parameters,
        });
      });
    }

    const request: SendTemplateMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "template",
      template: {
        name: parsedParams.template,
        language: {
          policy: "deterministic",
          code: parsedParams.languageCode,
        },
        components,
      },
    };

    const response = await service.performRequest(
      this.#sendTemplateMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendTemplate failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendTemplate performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendTextMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendTextMessageBodySchema.parse(params);

    log("message.sendText %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendTextMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "text",
      text: {
        body: parsedParams.text,
        preview_url: parsedParams.preview_url ?? true,
      },
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendTextMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendText failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendText performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendReactionMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendReactionMessageBodySchema.parse(params);

    log("message.sendReaction %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendReactionMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "reaction",
      reaction: {
        message_id: parsedParams.isReplyTo,
        emoji: parsedParams.emoji,
      },
    };

    const response = await service.performRequest(
      this.#sendReactionMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendReaction failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendReaction performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendImageMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendImageMessageBodySchema.parse(params);

    log("message.sendImage %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendImageMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "image",
      image: {
        link: parsedParams.url,
        caption: parsedParams.caption,
      },
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendImageMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendImage failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendImage performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendAudioMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendAudioMessageBodySchema.parse(params);

    log("message.sendAudio %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendAudioMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "audio",
      audio: {
        link: parsedParams.url,
      },
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendAudioMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendAudio failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendAudio performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendVideoMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendVideoMessageBodySchema.parse(params);

    log("message.sendVideo %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendVideoMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "video",
      video: {
        link: parsedParams.url,
        caption: parsedParams.caption,
      },
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendVideoMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendVideo failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendVideo performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendDocumentMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendDocumentMessageBodySchema.parse(params);

    log("message.sendDocument %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendDocumentMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "document",
      document: {
        link: parsedParams.url,
        caption: parsedParams.caption,
      },
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendDocumentMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendDocument failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendDocument performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendStickerMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendStickerMessageBodySchema.parse(params);

    log("message.sendSticker %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendStickerMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "sticker",
      sticker: {
        link: parsedParams.url,
        caption: parsedParams.caption,
      },
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendStickerMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendSticker failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendSticker performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendLocationMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendLocationMessageBodySchema.parse(params);

    log("message.sendLocation %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendLocationMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "location",
      location: {
        latitude: parsedParams.latitude,
        longitude: parsedParams.longitude,
        name: parsedParams.name,
        address: parsedParams.address,
      },
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendLocationMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendLocation failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendLocation performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendContactsMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendContactsMessageBodySchema.parse(params);

    log("message.sendContacts %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendContactsMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "contacts",
      contacts: parsedParams.contacts,
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendContactsMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendContacts failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const ok = !("error" in response.data);

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("message.sendContacts performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #getMediaUrl(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = EventMediaObjectSchema.parse(params);

    log("message.getMediaUrl %O", parsedParams);

    const url = `${process.env.APP_ORIGIN}/api/v1/internal/media/whatsapp/${
      metadata?.workflowId
    }/${parsedParams.id}?mime=${encodeURIComponent(
      parsedParams.mime_type
    )}&sha256=${parsedParams.sha256}`;

    return {
      ok: true,
      isRetryable: true,
      response: {
        output: url,
        context: {},
      },
    };
  }

  #isRetryable(statusCode: number): boolean {
    return (
      statusCode === 408 ||
      statusCode === 429 ||
      statusCode === 500 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504
    );
  }
}
