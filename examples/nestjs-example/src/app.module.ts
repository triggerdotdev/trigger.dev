import { MiddlewareConsumer, Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TriggerDevMiddlewareCreatorForExpress } from '@trigger.dev/nestjs';
import { TriggerClient } from '@trigger.dev/sdk';
import { client } from './trigger';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {
  private triggerClient: TriggerClient;
  constructor() {
    this.triggerClient = client;
  }
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TriggerDevMiddlewareCreatorForExpress(this.triggerClient)) // If you're using fastify platform use TriggerDevMiddlewareCreatorForFastify middleware.
      .forRoutes('/api/trigger');
  }
}
