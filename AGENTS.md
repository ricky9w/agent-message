# Agent instructions

Read `README.md` and `ARCHITECTURE.md` before changing this repository. `docs/protocol.md` is the
specification of everything two components say to each other; change it together with the code.

## Rules

- All code, comments and documentation are written in English.
- Run `bun run check` and `bun run test` before reporting a change as done. Run `bun run e2e` as well
  when the change touches the node's networking, the relay, or the protocol package.
- `packages/protocol` runs in both Bun and the Workers runtime. Use only Web APIs there.
- The node persists messages, agents and the roster, and nothing about who is connected. Do not add
  state to the database that changes while a session is merely running.
- A message is marked delivered only when the receiving session asks for it. Do not mark messages
  delivered when pushing to a harness.
- A client that is told it was superseded must not reconnect, and a reconnect loop must back off
  until the connection has proven stable. See `packages/cli/src/link.ts`.
- Tests do not wait for durations. Use `until` from `packages/cli/test/until.ts`, or an injected clock.
- The relay's tests are named `*.vitest.ts` so that Bun's test runner does not pick them up.
- Never deploy the relay or create Cloudflare resources as part of a change.
