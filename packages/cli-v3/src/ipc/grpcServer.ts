/**
 * gRPC Server for worker-coordinator communication.
 *
 * Runs in the coordinator (TaskRunProcess) and accepts connections
 * from worker processes via Unix domain sockets or TCP.
 */

import * as grpc from '@grpc/grpc-js';
import { EventEmitter } from 'events';
import { workerProto, WorkerMessage, CoordinatorMessage, LogLevel } from './protoLoader.js';
import { logger } from '../utilities/logger.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

export interface GrpcServerOptions {
  /**
   * Transport type: 'unix' for Unix domain sockets, 'tcp' for TCP localhost
   */
  transport?: 'unix' | 'tcp';

  /**
   * For TCP: port number (0 = random available port)
   */
  tcpPort?: number;

  /**
   * For Unix sockets: custom socket path
   */
  socketPath?: string;

  /**
   * Runner ID (used for socket naming in managed mode)
   */
  runnerId?: string;
}

export class GrpcWorkerServer extends EventEmitter {
  private server: grpc.Server;
  private address: string | null = null;
  private transport: 'unix' | 'tcp';
  private socketPath?: string;
  private streams: Map<string, grpc.ServerDuplexStream<WorkerMessage, CoordinatorMessage>> = new Map();

  constructor(private options: GrpcServerOptions = {}) {
    super();

    // Auto-detect transport: managed mode uses unix sockets, dev mode uses TCP
    this.transport = options.transport ?? (options.runnerId ? 'unix' : 'tcp');

    this.server = new grpc.Server();
    this.setupService();
  }

  private setupService() {
    this.server.addService(workerProto.WorkerService.service, {
      Connect: this.handleConnect.bind(this),
    });
  }

  private handleConnect(
    stream: grpc.ServerDuplexStream<WorkerMessage, CoordinatorMessage>
  ) {
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    logger.debug('Worker connected to gRPC server', { connectionId });

    this.streams.set(connectionId, stream);
    this.emit('connection', connectionId, stream);

    // Handle incoming messages from worker
    stream.on('data', (message: WorkerMessage) => {
      try {
        this.handleWorkerMessage(connectionId, message);
      } catch (error) {
        logger.error('Error handling worker message', {
          error: error instanceof Error ? error.message : String(error),
          connectionId,
        });
      }
    });

    stream.on('end', () => {
      logger.debug('Worker stream ended', { connectionId });
      this.streams.delete(connectionId);
      this.emit('disconnect', connectionId);
      stream.end();
    });

    stream.on('error', (error) => {
      logger.error('Worker stream error', {
        error: error.message,
        connectionId,
      });
      this.streams.delete(connectionId);
      this.emit('error', error, connectionId);
    });
  }

  private handleWorkerMessage(connectionId: string, message: WorkerMessage) {
    // Protobuf oneof fields are at the top level
    if (message.task_run_completed) {
      logger.debug('Received TASK_RUN_COMPLETED', {
        connectionId,
        id: message.task_run_completed.completion.id,
      });
      this.emit('TASK_RUN_COMPLETED', message.task_run_completed, connectionId);
    } else if (message.task_run_failed) {
      logger.debug('Received TASK_RUN_FAILED', {
        connectionId,
        id: message.task_run_failed.completion.id,
      });
      this.emit('TASK_RUN_FAILED_TO_RUN', message.task_run_failed, connectionId);
    } else if (message.task_heartbeat) {
      logger.debug('Received TASK_HEARTBEAT', {
        connectionId,
        id: message.task_heartbeat.id,
      });
      this.emit('TASK_HEARTBEAT', message.task_heartbeat, connectionId);
    } else if (message.index_tasks_complete) {
      logger.debug('Received INDEX_TASKS_COMPLETE', {
        connectionId,
        taskCount: message.index_tasks_complete.tasks.length,
      });
      this.emit('INDEX_TASKS_COMPLETE', message.index_tasks_complete, connectionId);
    } else if (message.log) {
      // Handle log messages from worker
      this.handleLogMessage(message.log, connectionId);
    } else {
      logger.warn('Unknown worker message type', { connectionId, message });
    }
  }

  private handleLogMessage(logMessage: any, connectionId: string) {
    const logData = {
      message: logMessage.message,
      logger: logMessage.logger,
      timestamp: logMessage.timestamp,
      connectionId,
      ...(logMessage.exception && { exception: logMessage.exception }),
    };

    // Route to appropriate log level
    switch (logMessage.level) {
      case LogLevel.DEBUG:
        logger.debug('Python worker', logData);
        break;
      case LogLevel.INFO:
        logger.info('Python worker', logData);
        break;
      case LogLevel.WARN:
        logger.warn('Python worker', logData);
        break;
      case LogLevel.ERROR:
        logger.error('Python worker', logData);
        if (logMessage.exception) {
          console.error(`[Python] ${logMessage.message}\n${logMessage.exception}`);
        }
        break;
      default:
        logger.info('Python worker', logData);
    }
  }

  /**
   * Send a message to a specific worker connection
   */
  sendToWorker(connectionId: string, message: CoordinatorMessage): boolean {
    const stream = this.streams.get(connectionId);
    if (!stream) {
      logger.warn('Attempted to send to non-existent connection', { connectionId });
      return false;
    }

    try {
      stream.write(message);
      return true;
    } catch (error) {
      logger.error('Error sending message to worker', {
        error: error instanceof Error ? error.message : String(error),
        connectionId,
      });
      return false;
    }
  }

  /**
   * Send a message to all connected workers
   */
  broadcast(message: CoordinatorMessage) {
    for (const [connectionId, stream] of this.streams) {
      try {
        stream.write(message);
      } catch (error) {
        logger.error('Error broadcasting to worker', {
          error: error instanceof Error ? error.message : String(error),
          connectionId,
        });
      }
    }
  }

  /**
   * Start the gRPC server
   */
  async start(): Promise<string> {
    if (this.address) {
      throw new Error('Server already started');
    }

    if (this.transport === 'unix') {
      this.address = await this.startUnixSocket();
    } else {
      this.address = await this.startTcp();
    }

    logger.debug('gRPC server started', {
      transport: this.transport,
      address: this.address,
    });

    return this.address;
  }

  private async startUnixSocket(): Promise<string> {
    // Generate socket path
    this.socketPath = this.options.socketPath ?? path.join(
      os.tmpdir(),
      `trigger-grpc-${this.options.runnerId || process.pid}.sock`
    );

    // Clean up existing socket if it exists
    if (fs.existsSync(this.socketPath)) {
      logger.debug('Cleaning up existing socket', { path: this.socketPath });
      fs.unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `unix:${this.socketPath}`,
        grpc.ServerCredentials.createInsecure(),
        (error, port) => {
          if (error) {
            reject(error);
          } else {
            resolve(`unix:${this.socketPath}`);
          }
        }
      );
    });
  }

  private async startTcp(): Promise<string> {
    const port = this.options.tcpPort ?? 0; // 0 = random available port

    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `localhost:${port}`,
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => {
          if (error) {
            reject(error);
          } else {
            resolve(`localhost:${boundPort}`);
          }
        }
      );
    });
  }

  /**
   * Stop the gRPC server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.tryShutdown(() => {
        // Clean up Unix socket if it exists
        if (this.socketPath && fs.existsSync(this.socketPath)) {
          try {
            fs.unlinkSync(this.socketPath);
          } catch (error) {
            logger.warn('Failed to clean up socket file', {
              path: this.socketPath,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        this.streams.clear();
        this.address = null;
        resolve();
      });
    });
  }

  /**
   * Force shutdown the server
   */
  forceShutdown(): void {
    this.server.forceShutdown();

    // Clean up Unix socket
    if (this.socketPath && fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch (error) {
        logger.warn('Failed to clean up socket file during force shutdown', {
          path: this.socketPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.streams.clear();
    this.address = null;
  }

  /**
   * Get the server address
   */
  getAddress(): string | null {
    return this.address;
  }

  /**
   * Get number of connected workers
   */
  getConnectionCount(): number {
    return this.streams.size;
  }

  /**
   * Get all connection IDs
   */
  getConnectionIds(): string[] {
    return Array.from(this.streams.keys());
  }
}
