export interface QueueBatch<T = unknown> {
  messages: T[];
}

export default {
  async queue(_batch: QueueBatch): Promise<void> {
    // queue consumer stub
  }
};
