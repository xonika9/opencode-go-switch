import type { Switcher } from "./switcher.ts";

/**
 * A fetch that runs every request through the switcher's hooks, for hosts that let a plugin supply the
 * transport instead of offering request and response hooks.
 */
export function createSwitchingFetch(
  switcher: Switcher,
  providerID: string,
  base: (request: Request) => Promise<Response>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const sent = { model: { providerID }, request: new Request(input, init) };
    await switcher.onRequest(sent);
    const received = { ...sent, response: await base(sent.request), fetch: base };
    await switcher.onResponse(received);
    return received.response;
  };
}
