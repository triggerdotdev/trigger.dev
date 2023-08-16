type QueueRoundRobinStorage = {
  [queueId: string]: number;
};

class QueueRoundRobin {
  private storage: QueueRoundRobinStorage = {};

  async next(queueId: string, maxJobs: number): Promise<number> {
    if (!this.storage.hasOwnProperty(queueId)) {
      this.storage[queueId] = 1;
    } else {
      this.storage[queueId] = (this.storage[queueId] % maxJobs) + 1;
    }
    return this.storage[queueId];
  }
}

export const queueRoundRobin = new QueueRoundRobin();
