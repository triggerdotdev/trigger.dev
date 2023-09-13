
import { safeParseBody } from '@trigger.dev/integration-kit';
import {
  ConnectionAuth,
  EventSpecification,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  Logger,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
  retry,
} from '@trigger.dev/sdk';
import { LinearSDK } from '@linear/sdk';
import { createHmac } from 'crypto';
import { z } from 'zod';

export type LinearIntegrationOptions = {
  id: string;
  apiKey?: string;
  clientId?: string;
  secret?: string;
};

type LinearRunTask = InstanceType<typeof Linear>['runTask'];

class Linear implements TriggerIntegration {
  private _options: LinearIntegrationOptions;
  private _client?: LinearSDK;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: LinearIntegrationOptions) {
    this._options = options;
  }

  get authSource() {
    return this._options.apiKey ? 'LOCAL' : 'HOSTED';
  }

  get id() {
    return this._options.id;
  }

  get metadata() {
    return { id: 'linear', name: 'Linear' };
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const linear = new Linear(this._options);
    linear._io = io;
    linear._connectionKey = connectionKey;
    linear._client = new LinearSDK({ apiKey: this._options.apiKey || auth.accessToken });
    return linear;
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: LinearSDK, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error('No IO');
    if (!this._connectionKey) throw new Error('No connection key');

    return this._io.runTask(
      key,
      (task, io) => {
        if (!this._client) throw new Error('No client');
        return callback(this._client, task, io);
      },
      {
        icon: 'linear',
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }

}

export default Linear;