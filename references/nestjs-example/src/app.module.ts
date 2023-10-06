import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TriggerDevModule } from '@trigger.dev/nestjs';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TriggerDevModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        id: 'my-nest-app',
        apiKey: config.getOrThrow('TRIGGER_API_KEY'),
        apiUrl: config.getOrThrow('TRIGGER_API_URL'),
        verbose: false,
        ioLogLocalEnabled: true,
      }),
    }),
  ],
  controllers: [AppController],
})
export class AppModule {}
