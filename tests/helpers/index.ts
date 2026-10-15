import type { TaskSnapshot, TaskStatus, TaskMode } from "../../src/core/task.ts";

export function makeSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: "task-1",
    name: "example",
    command: "echo example",
    mode: "background" satisfies TaskMode,
    status: "running" satisfies TaskStatus,
    createdAt: 0,
    notified: false,
    outputConsumed: false,
    metadata: {},
    ...overrides,
  };
}
