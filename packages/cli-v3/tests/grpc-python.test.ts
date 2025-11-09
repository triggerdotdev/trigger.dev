/**
 * Integration test for gRPC communication between Node.js coordinator and Python worker.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { GrpcWorkerServer } from '../src/ipc/grpcServer.js';
import path from 'path';

describe('gRPC Python IPC', () => {
  let server: GrpcWorkerServer;
  let serverAddress: string;

  beforeAll(async () => {
    // Start gRPC server
    server = new GrpcWorkerServer({ transport: 'tcp', tcpPort: 0 });
    serverAddress = await server.start();
    console.log(`[Test] gRPC server started at ${serverAddress}`);
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
      console.log('[Test] gRPC server stopped');
    }
  });

  it('should connect Python worker via gRPC and exchange messages', async () => {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Test timeout after 10 seconds'));
      }, 10000);

      // Track connection
      let connectionId: string | null = null;

      // Handle worker connection
      server.on('connection', (connId) => {
        console.log(`[Test] Worker connected: ${connId}`);
        connectionId = connId;

        // Send EXECUTE_TASK_RUN message
        const executeMessage = {
          message: {
            execute_task_run: {
              type: 'EXECUTE_TASK_RUN',
              version: 'v1',
              execution: {
                task: {
                  id: 'test-task',
                  file_path: 'test.py',
                },
                run: {
                  id: 'run-123',
                  payload: JSON.stringify({ message: 'Hello from gRPC!' }),
                  payload_type: 'application/json',
                  tags: ['test'],
                  is_test: true,
                },
                attempt: {
                  id: 'attempt-1',
                  number: 1,
                  started_at: new Date().toISOString(),
                },
              },
            },
          },
        };

        server.sendToWorker(connId, executeMessage);
        console.log('[Test] Sent EXECUTE_TASK_RUN message');
      });

      // Handle heartbeat
      server.on('TASK_HEARTBEAT', (message, connId) => {
        console.log(`[Test] Received TASK_HEARTBEAT from ${connId}`, message);
      });

      // Handle task completion
      server.on('TASK_RUN_COMPLETED', (message, connId) => {
        console.log(`[Test] Received TASK_RUN_COMPLETED from ${connId}`, message);

        clearTimeout(timeout);

        expect(message.completion).toBeDefined();
        expect(message.completion.id).toBe('run-123');

        // Clean up and resolve
        setTimeout(() => {
          pythonProcess?.kill();
          resolve();
        }, 500);
      });

      // Handle task failure
      server.on('TASK_RUN_FAILED_TO_RUN', (message, connId) => {
        console.log(`[Test] Received TASK_RUN_FAILED from ${connId}`, message);
        clearTimeout(timeout);
        reject(new Error(`Task failed: ${JSON.stringify(message.completion.error)}`));
      });

      // Handle disconnection
      server.on('disconnect', (connId) => {
        console.log(`[Test] Worker disconnected: ${connId}`);
      });

      // Spawn Python worker
      const pythonWorkerScript = path.join(
        __dirname,
        '../dist/esm/entryPoints/python/managed-run-worker.py'
      );

      const pythonProcess: ChildProcess = spawn('python3', [pythonWorkerScript], {
        env: {
          ...process.env,
          TRIGGER_GRPC_ADDRESS: serverAddress,
          PYTHONPATH: path.join(__dirname, '../../python-sdk'),
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      pythonProcess.stdout?.on('data', (data) => {
        console.log(`[Python stdout] ${data.toString()}`);
      });

      pythonProcess.stderr?.on('data', (data) => {
        console.log(`[Python stderr] ${data.toString()}`);
      });

      pythonProcess.on('error', (error) => {
        console.error('[Test] Python process error:', error);
        clearTimeout(timeout);
        reject(error);
      });

      pythonProcess.on('exit', (code, signal) => {
        console.log(`[Test] Python process exited with code ${code}, signal ${signal}`);
      });
    });
  }, 15000); // 15 second timeout for the test
});
