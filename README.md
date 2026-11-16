# agent-message

Messaging between coding agents. A session running in Claude Code can send a message to another
session, on the same machine or on another of your devices, and the other session receives it in
its context and can answer.

- **Sending** is a CLI call the agent makes when it needs to: `agent-message send <to> "<text>"`.
- **Receiving** needs no action from the agent: a harness plugin injects incoming messages into the
  session through the harness's own hooks, and can wake an idle session through its channel mechanism.
- **Local first.** Agents on one machine talk through a small background process on that machine.
  Nothing leaves it and no account or server is needed.
- **Across devices, optionally.** Devices exchange end-to-end encrypted messages through a relay that
  you deploy yourself (a Cloudflare Worker). The project does not operate a public relay.

## Status

Early. The protocol and the commands may still change.

| Harness     | Receive at next activity (hooks) | Wake when idle (channel)                               |
| ----------- | -------------------------------- | ------------------------------------------------------ |
| Claude Code | yes                              | yes, see [Waking idle sessions](#waking-idle-sessions) |
| Codex       | planned                          | planned                                                |

macOS and Linux are supported. Windows is not.

## Install

The CLI runs on [Bun](https://bun.sh) 1.4 or later. Install it globally:

```sh
bun add -g @ricky9w/agent-message
```

Then add the Claude Code plugin, which provides the hooks, the channel and the skill:

```sh
claude plugin marketplace add ricky9w/agent-message
claude plugin install agent-message@agent-message
```

The plugin runs the `agent-message` command, so it must be on the `PATH` that Claude Code sees.
Allow the command in your Claude Code permissions (`Bash(agent-message:*)`) so that agents can send and
read without asking each time.

## Use

Start two Claude Code sessions. Each is told its address when it starts, for example
`api-3f2a@laptop`: a name derived from the working directory, and the device name. Ask one of them to
message the other; the `agent-message` skill tells it how.

Give a session a stable name by setting `AGENT_MESSAGE_NAME` when you launch it:

```sh
AGENT_MESSAGE_NAME=reviewer claude
```

The same commands work from a terminal, with `--as <name>` to say who you are:

```sh
agent-message peers                                  # who is reachable
agent-message send reviewer "PR 42 is ready" --as me
agent-message inbox --as me                          # read replies
```

Run `agent-message --help` for the full list.

### When messages arrive

A message is handed to the recipient at the next of these moments:

- the user submits a prompt,
- a tool call finishes,
- the session is about to stop, in which case it continues with the message instead.

A session that is idle sees nothing until one of those happens, unless it can be woken.

### Waking idle sessions

Claude Code can inject events into an idle session through
[channels](https://code.claude.com/docs/en/channels), a research preview that must be enabled per
launch. For a plugin that is not on Anthropic's allowlist the flag is:

```sh
claude --dangerously-load-development-channels plugin:agent-message@agent-message
```

With it, an idle session is woken as soon as a message arrives. Without it everything else works the
same; idle sessions simply wait for their next activity. `agent-message peers` shows which sessions
are `live` (can be woken) and which are `idle`.

## Across devices

Deploy a relay once, then pair each device with it. See
[docs/relay-deployment.md](docs/relay-deployment.md).

```sh
agent-message relay init https://relay.example.workers.dev   # first device
agent-message relay invite                                   # prints the join command
agent-message relay join 'https://relay.example.workers.dev#<network>'   # on a new device; shows a code
agent-message devices approve xxxx-xxxx-xxxx                 # on a device that is already a member
```

Agents on other devices are addressed as `<agent>@<device>` and appear in `agent-message peers`.

Messages between devices are end-to-end encrypted; the relay sees only which device sends to which.
The encryption does not provide forward secrecy. Details are in [docs/protocol.md](docs/protocol.md).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): the parts of the system and how a message travels.
- [docs/protocol.md](docs/protocol.md): addresses, the local API, the relay protocol, encryption and the device roster.
- [docs/relay-deployment.md](docs/relay-deployment.md): deploying a relay and pairing devices.

## Development

```sh
bun install
bun run dev -- peers   # run the CLI from source
bun run check          # types and lint
bun run test           # unit tests, and the relay's tests in the Workers runtime
bun run e2e            # a real relay under `wrangler dev` and two nodes
bun run format
```

To try the plugin from a checkout, put a script named `agent-message` that runs
`bun /path/to/packages/cli/src/main.ts "$@"` on your `PATH`, and start Claude Code with
`--plugin-dir plugins/claude-code`.

### Releasing

`scripts/release.sh <version>` bumps the version, waits for CI, pushes the tag, and publishes the
GitHub release after the tag's workflow has published the package to npm. Publishing uses npm
trusted publishing, so the package carries a provenance attestation and no token is stored anywhere.

## License

[MIT](LICENSE)
