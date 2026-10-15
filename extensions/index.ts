import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearTaskActivity, raiseTaskActivity, reportActivity } from "../src/core/bus.ts";
import { sendCompletionNotification } from "../src/core/notify.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { SettleGuard } from "../src/guard/settle-guard.ts";
import { registerTools } from "../src/tools/index.ts";
import { registerRail } from "../src/tui/rail.ts";
import { disposeStatus, initStatus } from "../src/tui/status.ts";
import { registerPanelCommands } from "../src/tui/panel.ts";
import { isTerminal } from "../src/core/task.ts";

export type PiCtx = ExtensionAPI;

type RuntimeContext = PiCtx & {
  cwd?: string;
  pid?: number;
  sessionId?: string;
  getSessionId?: () => string | undefined;
  sessionManager?: { getSessionId?: () => string | undefined };
  mode?: string;
  on?: (event: string, handler: (...args: unknown[]) => unknown) => unknown;
  registerTool?: (...args: unknown[]) => unknown;
};

function registryDataDir(pi: PiCtx): string {
  const context = pi as RuntimeContext;
  const pid = Number.isInteger(context.pid) && (context.pid ?? 0) > 0 ? context.pid ?? process.pid : process.pid;
  const sessionId = context.sessionManager?.getSessionId?.() ?? context.getSessionId?.() ?? context.sessionId;
  const safeSessionId = (sessionId || String(process.pid)).replace(/[^\w.-]/g, "_");
  const cwd = typeof context.cwd === "string" && context.cwd.length > 0 ? context.cwd : process.cwd();
  return join(cwd, ".pi", "async", `${safeSessionId}-${pid}`);
}

/** Wire the task runtime to the host API, degrading optional Pi features gracefully. */
export async function init(pi: PiCtx): Promise<void> {
  const registry = new TaskRegistry({ dataDir: registryDataDir(pi) });
  await registry.reloadFromDisk();
  const tui = (pi as RuntimeContext).mode === "tui";

  registry.setEvents({
    onFinalize: (snapshot) => {
      clearTaskActivity(pi, snapshot.taskId);
      reportActivity(pi, registry.activeCount());
      if (tui) initStatus(pi, registry);
      if (snapshot.metadata.notifyOnCompletion === false) return;
      const outputFile = String(snapshot.metadata.outputFile ?? "");
      const outputTail = registry.logs(snapshot.taskId, { maxBytes: 8192, tail: true }).text;
      const guidance = snapshot.status === "failed" ? `Inspect task output with async_logs (taskId: ${snapshot.taskId}).` : undefined;
      void sendCompletionNotification(pi, registry, {
        taskId: snapshot.taskId,
        name: snapshot.name,
        status: snapshot.status,
        ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
        outputFile,
        ...(outputTail ? { summary: outputTail } : {}),
        ...(guidance ? { guidance } : {}),
      }).catch((error: unknown) => console.error(`pi-async: completion notification failed for ${snapshot.taskId}`, error));
    },
    onStateChange: (snapshot) => {
      const active = registry.activeCount();
      reportActivity(pi, active);
      if (isTerminal(snapshot.status)) clearTaskActivity(pi, snapshot.taskId);
      else raiseTaskActivity(pi, snapshot.taskId);
      if (tui) initStatus(pi, registry);
    },
  });

  const context = pi as RuntimeContext;
  if (typeof context.registerTool === "function") registerTools(pi, registry);
  if (tui) {
    initStatus(pi, registry);
    registerRail(pi, registry);
    registerPanelCommands(pi, registry);
  }
  if (typeof context.on === "function") new SettleGuard(pi, registry).register();

  let shutdownPromise: Promise<void> | undefined;
  if (typeof context.on === "function") {
    context.on("session_shutdown", async () => {
      if (!shutdownPromise) shutdownPromise = (async () => {
        if (tui) disposeStatus();
        await registry.shutdown();
      })();
      await shutdownPromise;
    });
  }
}

export default init;
