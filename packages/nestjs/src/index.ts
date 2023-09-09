import { Body, ConfigurableModuleBuilder, Controller, Delete, DynamicModule, Get, Head, Headers, HttpCode, Inject, InjectionToken, InternalServerErrorException, Module, NotFoundException, Options, Post, Put, Res } from '@nestjs/common';
import { Patch, Search } from '@nestjs/common/decorators/http/request-mapping.decorator';
import { Headers as StandardHeaders, Request as StandardRequest } from '@remix-run/web-fetch';
import { TriggerClient, TriggerClientOptions } from '@trigger.dev/sdk';

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } = new ConfigurableModuleBuilder<TriggerClientOptions>()
  .build();

/**
 * The injection token to use for the TriggerDev client.
 */
export const TriggerClientRef = Symbol('TriggerClientRef');

/**
 * Injects the TriggerDev client.
 * It will returns an instance of {@link TriggerClient}
 */
export const InjectTriggerDevClient = (customProviderToken: InjectionToken = TriggerClientRef) => Inject(customProviderToken);

/**
 * The TriggerDev module for NestJS.
 *
 * Use {@link TriggerDevModule.register} to register the module, or {@link TriggerDevModule.registerAsync} to register it asynchronously.
 *
 * @example```ts
 * import { Module } from '@nestjs/common';
 * import { TriggerDevModule } from '@trigger.dev/nestjs';
 *
 * @Module({
 *   imports: [
 *     TriggerDevModule.register({
 *       id: 'my-client',
 *       apiKey: process.env['TRIGGER_API_KEY']!,
 *     }),
 *     // you can also can configure it asynchnously
 *     TriggerDevModule.registerAsync({
 *       inject: [YouConfigService],
 *       useFactory: (configService: YouConfigService) => {
 *         return {
 *           id: 'my-client',
 *           apiKey: configService.get('TRIGGER_API_KEY'),
 *         };
 *       },
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class TriggerDevModule extends ConfigurableModuleClass {
  /**
   * Register the instance for the TriggerDev client.
   *
   * Hint: If you want to have multiple instances of the client, you can use the `customProviderToken` to create multiple instances.
   *
   * @param options The options to use for the client
   * @param path The path to use for the controller (default: `/api/trigger`)
   * @param customProviderToken The token to use for the provider (default: {@link TriggerClientRef})
   */
  static register(options: typeof OPTIONS_TYPE, path: string = '/api/trigger', customProviderToken: InjectionToken = TriggerClientRef): DynamicModule {
    const { providers, ...rest } = ConfigurableModuleClass.register(options);
    const controller = createControllerByPath(customProviderToken, path);

    return {
      ...rest,
      controllers: [
        controller,
      ],
      providers: [
        ...(providers || []),
        {
          provide: customProviderToken,
          inject: [MODULE_OPTIONS_TOKEN],
          useFactory: (options: TriggerClientOptions) => {
            return new TriggerClient(options);
          },
        },
      ],
      exports: [
        customProviderToken,
      ],
    };
  }

  /**
   * Register the instance for the TriggerDev client asynchronously.
   *
   * Hint: If you want to have multiple instances of the client, you can use the `customProviderToken` to create multiple instances.
   *
   * @param options The options to use for the client
   * @param path The path to use for the controller (default: `/api/trigger`)
   * @param customProviderToken The token to use for the provider (default: {@link TriggerClientRef})
   */
  static registerAsync(options: typeof ASYNC_OPTIONS_TYPE, path: string = '/api/trigger', customProviderToken: InjectionToken = TriggerClientRef): DynamicModule {
    const { providers, ...rest } = ConfigurableModuleClass.registerAsync(options);
    const controller = createControllerByPath(customProviderToken, path);

    return {
      ...rest,
      controllers: [
        controller,
      ],
      providers: [
        ...(providers || []),
        {
          provide: customProviderToken,
          inject: [MODULE_OPTIONS_TOKEN],
          useFactory: (options: TriggerClientOptions) => {
            return new TriggerClient(options);
          },
        },
      ],
      exports: [
        customProviderToken,
      ],
    };
  }
}

/**
 * Used to create a custom controller for NestJS with specific path to handle TriggerDev requests.
 *
 * @param customProvider The provider to use to inject the TriggerDev client
 * @param path The path to use for the controller
 */
function createControllerByPath(customProvider: InjectionToken, path: string) {
  @Controller(path)
  class TriggerDevController {
    constructor(
      @InjectTriggerDevClient(customProvider)
      private readonly client: TriggerClient,
    ) {
    }

    @Head()
    @HttpCode(200)
    public empty() {}

    @Post()
    public handleRequestPost(@Res({ passthrough: true }) res: any, @Headers() headers: unknown, @Body() body?: unknown): Promise<unknown> {
      return this.handleRequest(res, 'POST', headers, body);
    }

    @Delete()
    public handleRequestDelete(@Res({ passthrough: true }) res: any, @Headers() headers: unknown, @Body() body?: unknown): Promise<unknown> {
      return this.handleRequest(res, 'DELETE', headers, body);
    }

    @Get()
    public handleRequestGet(@Res({ passthrough: true }) res: any, @Headers() headers: unknown, @Body() body?: unknown): Promise<unknown> {
      return this.handleRequest(res, 'GET', headers, body);
    }

    @Put()
    public handleRequestPut(@Res({ passthrough: true }) res: any, @Headers() headers: unknown, @Body() body?: unknown): Promise<unknown> {
      return this.handleRequest(res, 'PUT', headers, body);
    }

    @Patch()
    public handleRequestPatch(@Res({ passthrough: true }) res: any, @Headers() headers: unknown, @Body() body?: unknown): Promise<unknown> {
      return this.handleRequest(res, 'PATCH', headers, body);
    }

    @Options()
    public handleRequestOptions(@Res({ passthrough: true }) res: any, @Headers() headers: unknown, @Body() body?: unknown): Promise<unknown> {
      return this.handleRequest(res, 'OPTIONS', headers, body);
    }

    @Search()
    public handleRequestSearch(@Res({ passthrough: true }) res: any, @Headers() headers: unknown, @Body() body?: unknown): Promise<unknown> {
      return this.handleRequest(res, 'SEARCH', headers, body);
    }

    /**
     * Forward the request to the TriggerDev client
     */
    public async handleRequest(res: any, method: string, requestHeaders: unknown, requestBody?: unknown): Promise<unknown> {
      // try {
      const headers = new StandardHeaders();

      Object.entries(requestHeaders || {}).forEach(([key, value]) => {
        headers.set(key, value as string);
      });

      // Create a new Request object (hardcode the url because it doesn't really matter what it is)
      const standardRequest = new StandardRequest('https://nestjs.com/api/trigger', {
        headers,
        method,
        // @ts-ignore
        body: requestBody ? JSON.stringify(requestBody) : undefined,
      });

      const response = await this.client.handleRequest(standardRequest);

      if (!response) {
        throw new NotFoundException({ error: 'Not found' });
      }

      if (typeof res.status === 'function') { // express
        res.status(response.status);
      } else if (typeof res.code === 'function') { // fastify
        res.code(response.status);
      } else {
        throw new InternalServerErrorException('Unable to indetify the framework to set the status code, are you using Express or Fastify?');
      }

      return response.body;
    }
  }

  return TriggerDevController;
}
