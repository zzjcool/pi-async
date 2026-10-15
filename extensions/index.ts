import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskRegistry } from "../src/core/registry.ts";
import { SettleGuard } from "../src/guard/settle-guard.ts";
import { registerTools } from "../src/tools/index.ts";
import { initStatus } from "../src/tui/status.ts";
import { registerPanelCommands } from "../src/tui/panel.ts";

export type PiCtx = ExtensionAPI;

/** Step 0 extension wiring scaffold; feature modules are implemented in later steps. */
export async function init(pi: PiCtx): Promise<void> {
  const registry = new TaskRegistry({ dataDir: ".pi/async" });
  await registry.reloadFromDisk();
  registry.setEvents({ onFinalize: () => undefined, onStateChange: () => undefined });
  registerTools(pi, registry);

  // The mode/context wiring is finalized in Step I against the installed Pi API.
  if ((pi as PiCtx & { mode?: string }).mode === "tui") {
    initStatus(pi, registry);
    registerPanelCommands(pi, registry);
  }

  new SettleGuard(pi, registry).register();
  pi.on("session_shutdown", () => { void registry.shutdown(); });
}

export default init;
