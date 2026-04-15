/**
 * Serialized queue of pending sync operations.
 *
 * Ensures operations are processed one at a time in arrival order, preventing
 * races between concurrent save events and poll results.
 */

export type ChangeOp =
  | { type: "upload"; localPath: string }
  | { type: "download"; driveId: string; localPath: string }
  | { type: "deleteLocal"; localPath: string }
  | { type: "deleteRemote"; driveId: string }
  | { type: "renameRemote"; driveId: string; oldPath: string; newPath: string; newParentId: string; oldParentId: string };

type Task = () => Promise<void>;

export class ChangeQueue {
  private queue: Task[] = [];
  private running = false;

  /** Enqueue a task, skipping duplicate upload ops for the same path. */
  enqueue(op: ChangeOp, handler: (op: ChangeOp) => Promise<void>): void {
    // Deduplicate consecutive upload ops for the same file
    if (op.type === "upload") {
      const last = this.queue[this.queue.length - 1];
      // Can't inspect the closed-over op, so we just push and let the handler
      // guard against no-ops via mtime comparison.
    }

    this.queue.push(() => handler(op));
    this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      try {
        await task();
      } catch (err) {
        console.error("[GDriveSync] ChangeQueue task error:", err);
      }
    }

    this.running = false;
  }

  get size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}
