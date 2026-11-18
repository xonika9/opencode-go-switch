import { Rpc } from "@opencode/plugin/rpc";

export const RPC_ID = "opencode-go-switch";

/**
 * Server-to-TUI notification contract. Events carry only the account label and the reason for the
 * switch; credential material never leaves the server plugin.
 */
export const Contract = Rpc.define({
  id: RPC_ID,
  methods: {},
  events: {
    switched: {
      schema: {
        type: "object",
        properties: {
          label: { type: "string" },
          reason: { type: "string" },
        },
        required: ["label", "reason"],
        additionalProperties: false,
      } as const,
    },
  },
});
