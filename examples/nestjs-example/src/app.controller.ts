import { Controller, Get } from '@nestjs/common';
import { InjectTriggerDevClient } from '@trigger.dev/nestjs';
import { eventTrigger, TriggerClient } from '@trigger.dev/sdk';

@Controller()
export class AppController {
  constructor(
    @InjectTriggerDevClient() private readonly client: TriggerClient,
  ) {
    this.client.defineJob({
      id: 'test-job',
      name: 'Test Job One',
      version: '0.0.1',
      trigger: eventTrigger({
        name: 'test.event',
      }),
      run: async (payload, io, ctx) => {
        await io.logger.info('Hello world!', { payload });

        return {
          message: 'Hello world!',
        };
      },
    });
  }

  @Get()
  getHello(): string {
    return `Running Trigger.dev with client-id ${ this.client.id }`;
  }
}
