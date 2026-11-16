# Architecture

agent-message has three kinds of parts: one **node** per device, **harness adapters** that connect
agent sessions to the node, and an optional **relay** that connects nodes on different devices.

```
 device "laptop"                                     device "mini"
┌───────────────────────────────────────┐           ┌──────────────────────────┐
│ Claude Code session                   │           │        session           │
│   │ agent runs CLI      ▲ hooks,      │           │           ▲              │
│   ▼                     │ channel     │           │           │              │
│ ┌─────────────────────────────────┐   │           │   ┌───────────────┐      │
│ │ node  (Unix socket, SQLite)     │◀──┼──┐     ┌──┼──▶│     node      │      │
│ └─────────────────────────────────┘   │  │     │  │   └───────────────┘      │
└───────────────────────────────────────┘  │     │  └──────────────────────────┘
                                           ▼     ▼
                                   ┌──────────────────┐
                                   │ relay (optional) │  sees device ids and ciphertext
                                   └──────────────────┘
```

Agents and adapters only ever talk to the node on their own device. Whether a recipient is local or
on another device is the node's concern, so sending and receiving look the same in both cases.

## Repository layout

| Path                  | Contents                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`   | Types and cryptography shared by the node and the relay: addresses, messages, device keys, the roster, envelopes, request signing. Runs in Bun and in the Workers runtime. |
| `packages/cli`        | The `agent-message` program: the CLI, the node, and the harness adapters.                                                                                                  |
| `packages/relay`      | The relay: a Cloudflare Worker with one SQLite-backed Durable Object.                                                                                                      |
| `plugins/claude-code` | The Claude Code plugin: hook configuration, the channel server entry, and the skill.                                                                                       |
| `e2e`                 | End-to-end test with a real relay and two nodes.                                                                                                                           |

## The node

One background process per device and user (`packages/cli/src/server.ts`, `node.ts`). It starts on
demand the first time anything needs it and listens on a Unix socket in its home directory
(`$AGENT_MESSAGE_HOME`, by default `~/.local/state/agent-message`). It holds its SQLite database
with an exclusive lock, so a second node on the same home exits immediately.

**Agents.** An agent is a harness session, identified by harness name and session id, with a name
that is unique on the device. The name is chosen once, from `AGENT_MESSAGE_NAME` or from the working
directory, and stays with the session. A new session may request a name that a finished session
held and thereby inherit its undelivered mail.

**What is stored.** Agents, their inboxes, envelopes waiting for the relay, and the device roster.
Who is connected and which sessions are busy is kept in memory only: none of it needs to survive a
restart, and writing it would turn every connection change into disk activity.

**Delivery.** A message is delivered when the receiving session asks for its mail, and only then is
it marked delivered. Sessions ask through their hooks at natural points of a turn. A push to a
harness is never treated as delivery, because a harness may drop it without saying so.

**Waking.** A session that is idle does not ask. If an adapter holds a connection to the node for
that session (an _attachment_), the node sends it a wake event, and the adapter prompts the session,
which then collects its mail as usual. The node considers a session busy from its last hook activity
until a hook reports the turn ending with nothing left to read, or for ten minutes at most, and does
not wake busy sessions.

**One attachment per agent.** A newer attachment replaces the older one, which is told that it was
superseded and must not attach again.

## Harness adapters

An adapter is the part that knows one harness. Both mechanisms below live in `packages/cli` and are
wired to Claude Code by `plugins/claude-code`.

**Hooks** (`hook.ts`). The harness runs `agent-message hook <harness>` at session start, on each user
prompt, after each tool call, when the session is about to stop, and at session end. Session start
registers the session and tells the agent its address. The others collect waiting mail and return it
as additional context; at stop, mail makes the session continue instead. Hooks inside subagents are
ignored, since a subagent's context is not the session's.

**Channel** (`channel.ts`). A minimal MCP server over stdio that declares Claude Code's channel
capability. It attaches to the node and turns wake events into channel notifications. It carries no
message content and offers no tools.

**Identity.** Harnesses export their session id to the commands an agent runs
(`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`), which is how the CLI knows who is sending. The channel
server keeps the session id it was started with while the harness process may move on to another
session (`/clear`, resume); the node notices when a session-start hook runs under a process that
already has a channel and moves the channel to the new session.

## The network

Optional (`network.ts`, `link.ts`). A _network_ is a set of devices that trust each other, recorded
in a **roster**: an append-only log of signed entries, each adding or revoking a device. The first
entry founds the network and its hash is the network id; every later entry is signed by a device
that was a member at that point. Every device verifies the whole log itself.

Each device has two key pairs, one for signing and one for encryption. A device's id is a hash of
its public keys.

A node keeps one WebSocket to the relay. Over it, devices exchange **envelopes**: a payload signed
by the sending device and encrypted to the receiving device. Payloads are either a message for an
agent, or the sender's current list of agents, which is how `agent-message peers` knows about
agents elsewhere.

A message for another device is sealed, stored in the sender's outbox, and removed when the relay
confirms it has it. The relay keeps it until the receiving node confirms it stored the message.

## The relay

A Cloudflare Worker that forwards every request to a single Durable Object (`packages/relay`). It

- keeps the roster and accepts new entries only if they are valid and signed by a member,
- authenticates each request and connection by the device's signature,
- holds pairing requests from devices waiting to be approved,
- queues envelopes for devices that are offline and forwards them to devices that are connected.

It cannot read envelopes and cannot forge roster entries. It can see which device talks to which,
when, and how much, and it can withhold or delay envelopes.

## What to read next

[docs/protocol.md](docs/protocol.md) specifies each of these interfaces.
