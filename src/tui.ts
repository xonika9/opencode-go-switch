import { Plugin } from "@opencode/plugin/tui";
import { Contract } from "./rpc.ts";

export default Plugin.define({
  id: "opencode-go-autoswitch-tui",
  setup(context) {
    const rpc = context.client.rpc(Contract);
    return rpc.events.on("switched", (event) => {
      context.ui.toast.show({
        title: "Go Switch",
        message: `Now using ${event.data.label} (${event.data.reason})`,
        variant: "info",
      });
    });
  },
});
