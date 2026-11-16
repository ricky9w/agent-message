# Protocol

This document specifies what the parts of agent-message say to each other. The types named here are
defined in `packages/protocol/src` and `packages/cli/src/api.ts`; where the two disagree, that is a bug.

Protocol version: **1**.

## Names and addresses

Agent names and device names are 1 to 63 characters from `a-z 0-9 . _ -`, starting with a letter or
digit. An address is `<agent>` for an agent on the local device, or `<agent>@<device>`. Messages
always carry full addresses.

## Messages

```ts
type Message = {
  id: string; // unique, chosen by the sending node
  from: string; // agent@device
  to: string; // agent@device
  body: string; // text, at most 64 KiB of UTF-8
  replyTo?: string; // id of the message this one answers
  sentAt: number; // milliseconds since the Unix epoch, sender's clock
};
```

An undelivered message is dropped seven days after `sentAt`.

## Local API

The node listens on the Unix socket `node.sock` in its home directory, which only the owning user
can open. It speaks HTTP.

### `POST /rpc`

Body `{ "op": string, "params": object }`. The answer is `{ "result": ... }`, or
`{ "error": { "code": string, "message": string } }` with status 400 for a refused request and 500
for a fault in the node. The operations and their types are the `Api` type in `api.ts`:

| Operation   | Purpose                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| `ping`      | Version, process id and device name of the node.                                     |
| `register`  | A harness session started or resumed. Returns its address and any waiting messages.  |
| `end`       | A harness session ended.                                                             |
| `whoami`    | The caller's address.                                                                |
| `send`      | Send a message. The result says whether the recipient is `live`, `idle` or `remote`. |
| `take`      | Return the caller's waiting messages and mark them delivered.                        |
| `peers`     | Reachable agents on this device and, if networked, on the others.                    |
| `stop`      | Shut the node down.                                                                  |
| `network.*` | Found, join, inspect and leave a network; approve and revoke devices.                |

A **caller** is `{ as: name }`, or `{ harness, session }` for a harness session. A caller that is not
yet known is registered on the spot.

`take` may carry `turn`: `"active"` from a hook that runs while the session is working, `"ending"`
from one that runs as it is about to stop. The node uses it to decide whether the session needs to
be woken for later messages.

### `POST /attach`

Body: a session (`harness`, `session`, `cwd`, optional `name`) and `pid`, the process id of the
harness. The response stays open and carries one JSON object per line, with empty lines as keepalive:

| Event                               | Meaning                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `{ "type": "attached", "address" }` | First event.                                                                |
| `{ "type": "wake", "pending" }`     | Messages are waiting and the session looks idle. Prompt it to collect them. |
| `{ "type": "superseded" }`          | Another attachment replaced this one. The client must not attach again.     |

A client whose stream ends for any other reason reattaches, with a delay that doubles from one
second to one minute and is reset only after a connection has lasted thirty seconds.

## Devices

A device has an Ed25519 key pair for signatures and an X25519 key pair for encryption. Public keys
are exchanged as base64url of their raw 32 bytes.

```ts
type Device = { id: string; name: string; signKey: string; kexKey: string };
```

The **device id** is the first 20 bytes of `SHA-256(signKey ‖ kexKey)` in lowercase unpadded base32
(32 characters). The **pairing code** is the first 12 characters of the id, shown in groups of four.

## Roster

A network's roster is an ordered log of entries:

```ts
type RosterEntry = {
  prev: string; // hash of the previous entry, "" for the first
  action: "add" | "revoke";
  device: Device | { id }; // the device added, or the id revoked
  by: string; // id of the signing device
  at: number; // informational
  sig: string; // Ed25519 signature by `by`
};
```

**Canonical form.** Signatures and hashes are computed over JSON with object keys sorted, no
whitespace, and absent members omitted. The signature covers the canonical form of the entry without
`sig`. The hash of an entry is base64url of the SHA-256 of its canonical form including `sig`.

An entry is valid if all of these hold:

- `prev` is the hash of the entry before it.
- The first entry adds a device and is signed by that device. Every other entry is signed by a
  device that is a member before the entry is applied.
- An added device's id matches its keys, was never in the roster before, and its name is not held
  by a current member.
- A revoked device is a current member.

The **network id** is the first 16 bytes of the SHA-256 of the first entry's hash, in base32.

Every device replays and verifies the log itself. A device that joins is given the network id out of
band and refuses a roster that does not start from it.

## Envelopes

Devices exchange envelopes through the relay:

```ts
type Envelope = {
  id: string;
  from: string; // sending device id
  to: string; // receiving device id
  expires: number; // when the relay may drop it, milliseconds since the Unix epoch
  ephemeral?: true; // drop instead of queueing when the receiver is offline
  box: string; // base64url(enc ‖ ciphertext)
};
```

**Sealing.** Let `aad` be the canonical form of the envelope without `box`, and `body` the JSON text
of the payload. The sender signs `aad ‖ 0x00 ‖ body` with its Ed25519 key, and encrypts the JSON
object `{ body, sig }` with HPKE (RFC 9180) in base mode to the receiver's X25519 key, with
DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM, `info` = `agent-message/v1/envelope`, and
`aad` as associated data. `box` is the 32-byte encapsulated key followed by the ciphertext.

**Opening.** The receiver decrypts, looks the sender up in its roster by `from`, and verifies the
signature. An envelope that fails any step is dropped.

**Payloads.**

```ts
type Payload = { type: "message"; message: Message } | { type: "agents"; agents: AgentInfo[]; at: number }; // the sender's complete agent list
```

A receiver accepts a message only if the device part of `message.from` is the sending device's name
and the device part of `message.to` is its own. Message ids make redelivery harmless. An agent list
replaces any earlier list from that device with a smaller `at`; it is sent as an ephemeral envelope
whenever the list changes or another device comes online.

**Forward secrecy.** This scheme does not provide forward secrecy.

## Relay

A relay serves exactly one network.

### Authentication

Requests from devices carry

```
Authorization: AgentMessage <device id>.<timestamp>.<signature>
```

where the signature is Ed25519 over these five lines joined by `\n`:

```
agent-message/v1/request
<METHOD>
<host><path><query>
<timestamp>
<base64url(SHA-256(body))>
```

The timestamp is in milliseconds and must be within two minutes of the relay's clock. Unless stated
otherwise the signer must be a current member of the roster.

Errors are `{ "error": string }` with an HTTP status.

### HTTP endpoints

| Endpoint                   | Authentication                            | Purpose                                                        |
| -------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `GET /v1`                  | none                                      | `{ protocol, network }`; `network` is null before founding.    |
| `POST /v1/init`            | `Bearer <bootstrap token>`                | Found the network with `{ entry }`. Works once.                |
| `POST /v1/pair`            | signed by the device in the body          | A device asks to join with `{ device }`. Kept for ten minutes. |
| `GET /v1/pair/<code>`      | member                                    | The pending device whose id starts with the code.              |
| `GET /v1/roster?after=<n>` | member                                    | `{ entries }` from index `n`.                                  |
| `POST /v1/roster`          | member, and `entry.by` must be the signer | Append `{ entry }`.                                            |
| `GET /v1/connect`          | member                                    | WebSocket upgrade.                                             |

### Pairing

1. The new device posts its public identity to `/v1/pair` and shows its pairing code.
2. On a member device the user enters the code. That device fetches the pending request, checks
   that the returned keys hash to an id starting with the code, signs an `add` entry and appends it.
3. The new device polls `/v1/roster` until it is admitted, verifies the log, and checks the network id.

The code binds the approval to the new device's keys, and the network id binds the new device to
the network it meant to join. The relay cannot substitute either without being detected.

### WebSocket frames

Text frames of JSON. From a device:

| Frame                     | Meaning                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `{ t: "send", envelope }` | Deliver this envelope.                                          |
| `{ t: "ack", id }`        | The envelope is stored on this device; the relay may delete it. |

From the relay:

| Frame                               | Meaning                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `{ t: "hello", roster, online }`    | First frame: roster length and the ids of the other connected devices. |
| `{ t: "deliver", envelope }`        | An envelope for this device.                                           |
| `{ t: "sent", id }`                 | The relay has taken the envelope; the sender may forget it.            |
| `{ t: "rejected", id, reason }`     | The relay will never deliver the envelope.                             |
| `{ t: "roster", roster }`           | The roster grew to this length.                                        |
| `{ t: "presence", device, online }` | Another device connected or disconnected.                              |

The text frame `ping` is answered with `pong`.

A device has at most one connection. A new one closes the old one with code `4001`; a revoked
device's connection is closed with `4003`. A node that receives either code stops and does not
reconnect.

### Relay limits

| Limit                    | Value                           |
| ------------------------ | ------------------------------- |
| Envelope size (JSON)     | 128 KiB                         |
| Time an envelope is kept | until `expires`, at most 7 days |
| Queued envelopes         | 10,000                          |
| Pending pairing requests | 8                               |

## What the relay can and cannot do

It can see device ids, timing and sizes, and it can drop or delay envelopes. It cannot read or
alter payloads, impersonate a device, or change the roster.
