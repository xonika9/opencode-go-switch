import { Plugin } from "@opencode/plugin/tui";
import { Contract } from "./rpc.ts";

/**
 * TUI side of the switch notification. The server emits RPC events; this plugin turns them into a
 * toast. T3 Code does not render these, so the `go_accounts` tool is the primary status surface.
 */
export default Plugin.define({
  id: "opencode-go-autoswitch-tui",
  setup(context) {
    if (context.options.toast === false) return;
    const rpc = context.client.rpc(Contract);
    return rpc.events.on("switched", (event) => {
      context.ui.toast.show({
        title: "OpenCode Go",
        message: `Now using ${event.data.label} (${event.data.reason})`,
        variant: "info",
      });
    });
  },
});
