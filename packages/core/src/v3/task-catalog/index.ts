const API_NAME = "task-catalog";

import { TaskFileMetadata, TaskMetadataWithFilePath } from "../schemas/index.js";
import { TaskMetadataWithFunctions } from "../types/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { type TaskCatalog } from "./catalog.js";
import { NoopTaskCatalog } from "./noopTaskCatalog.js";

const NOOP_TASK_CATALOG = new NoopTaskCatalog();

export class TaskCatalogAPI {
  private static _instance?: TaskCatalogAPI;

  private constructor() {}

  public static getInstance(): TaskCatalogAPI {
    if (!this._instance) {
      this._instance = new TaskCatalogAPI();
    }

    return this._instance;
  }

  public setGlobalTaskCatalog(taskCatalog: TaskCatalog): boolean {
    return registerGlobal(API_NAME, taskCatalog);
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  public registerTaskMetadata(task: TaskMetadataWithFunctions): void {
    this.#getCatalog().registerTaskMetadata(task);
  }

  public updateTaskMetadata(id: string, updates: Partial<TaskMetadataWithFunctions>): void {
    this.#getCatalog().updateTaskMetadata(id, updates);
  }

  public registerTaskFileMetadata(id: string, metadata: TaskFileMetadata): void {
    this.#getCatalog().registerTaskFileMetadata(id, metadata);
  }

  public getAllTaskMetadata(): Array<TaskMetadataWithFilePath> {
    return this.#getCatalog().getAllTaskMetadata();
  }

  public getTaskMetadata(id: string): TaskMetadataWithFilePath | undefined {
    return this.#getCatalog().getTaskMetadata(id);
  }

  public getTask(id: string): TaskMetadataWithFunctions | undefined {
    return this.#getCatalog().getTask(id);
  }

  public taskExists(id: string): boolean {
    return this.#getCatalog().taskExists(id);
  }

  #getCatalog(): TaskCatalog {
    return getGlobal(API_NAME) ?? NOOP_TASK_CATALOG;
  }
}
