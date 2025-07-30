const API_NAME = "resource-catalog";

import { QueueManifest, TaskManifest, WorkerManifest } from "../schemas/index.js";
import { TaskMetadataWithFunctions, TaskSchema } from "../types/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { type ResourceCatalog } from "./catalog.js";
import { NoopResourceCatalog } from "./noopResourceCatalog.js";

const NOOP_RESOURCE_CATALOG = new NoopResourceCatalog();

export class ResourceCatalogAPI {
  private static _instance?: ResourceCatalogAPI;

  private constructor() {}

  public static getInstance(): ResourceCatalogAPI {
    if (!this._instance) {
      this._instance = new ResourceCatalogAPI();
    }

    return this._instance;
  }

  public setGlobalResourceCatalog(resourceCatalog: ResourceCatalog): boolean {
    return registerGlobal(API_NAME, resourceCatalog);
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  public registerQueueMetadata(queue: QueueManifest): void {
    this.#getCatalog().registerQueueMetadata(queue);
  }

  public registerTaskMetadata(task: TaskMetadataWithFunctions): void {
    this.#getCatalog().registerTaskMetadata(task);
  }

  public updateTaskMetadata(id: string, updates: Partial<TaskMetadataWithFunctions>): void {
    this.#getCatalog().updateTaskMetadata(id, updates);
  }

  public setCurrentFileContext(filePath: string, entryPoint: string): void {
    this.#getCatalog().setCurrentFileContext(filePath, entryPoint);
  }

  public clearCurrentFileContext(): void {
    this.#getCatalog().clearCurrentFileContext();
  }

  public registerWorkerManifest(workerManifest: WorkerManifest): void {
    this.#getCatalog().registerWorkerManifest(workerManifest);
  }

  public listTaskManifests(): Array<TaskManifest> {
    return this.#getCatalog().listTaskManifests();
  }

  public getTaskManifest(id: string): TaskManifest | undefined {
    return this.#getCatalog().getTaskManifest(id);
  }

  public getTask(id: string): TaskMetadataWithFunctions | undefined {
    return this.#getCatalog().getTask(id);
  }

  public getTaskSchema(id: string): TaskSchema | undefined {
    return this.#getCatalog().getTaskSchema(id);
  }

  public taskExists(id: string): boolean {
    return this.#getCatalog().taskExists(id);
  }

  public listQueueManifests(): Array<QueueManifest> {
    return this.#getCatalog().listQueueManifests();
  }

  #getCatalog(): ResourceCatalog {
    return getGlobal(API_NAME) ?? NOOP_RESOURCE_CATALOG;
  }
}
