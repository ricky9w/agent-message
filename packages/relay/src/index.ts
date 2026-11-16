export { Relay } from "./relay.ts";

export default {
  // One relay serves one network, so a single object holds all of its state.
  fetch: (request, env) => env.RELAY.getByName("relay").fetch(request),
} satisfies ExportedHandler<Env>;
