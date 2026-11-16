# Deploying a relay

A relay lets your devices exchange messages. You need one per network, and you deploy it yourself:
the project does not run a public one. Without a relay, agent-message works between agents on the
same machine.

The relay is a Cloudflare Worker with one SQLite-backed Durable Object. It fits within the Workers
Free plan for personal use.

## Deploy

You need a Cloudflare account and this repository.

```sh
bun install
cd packages/relay
bunx wrangler login
```

Generate the bootstrap token, which authorizes founding the network exactly once, and deploy with it:

```sh
umask 077
printf 'BOOTSTRAP_TOKEN=%s\n' "$(openssl rand -hex 32)" > relay-secrets.env
bunx wrangler deploy --secrets-file relay-secrets.env
```

Wrangler prints the relay's URL, for example `https://agent-message-relay.<account>.workers.dev`.
Keep `relay-secrets.env` until the next step is done, then delete it. The token is useless once the
network exists.

### Custom domain

To serve the relay from a hostname in one of your Cloudflare zones, name it when deploying:

```sh
bunx wrangler deploy --secrets-file relay-secrets.env --domain relay.example.com
```

Wrangler creates the DNS record and certificate, and the `workers.dev` address is not enabled.
Pass `--domain` on every later deploy as well.

If the zone is protected by Cloudflare Access, for example by a wildcard application, the relay
answers with a redirect to the Access login and no device can reach it. Add an Access application
for the relay's hostname with a bypass policy. The relay authenticates every request itself.

### Check the deployment

```sh
curl https://<relay host>/v1    # {"protocol":1,"network":null}
```

## Found the network

On the first device:

```sh
agent-message relay init https://agent-message-relay.<account>.workers.dev
```

Enter the bootstrap token when asked, or pass it in `AGENT_MESSAGE_BOOTSTRAP_TOKEN`. The device is
named after its host; choose another name with `--device-name`.

## Add a device

1. On a device that is already a member, print the join command:

   ```sh
   agent-message relay invite
   ```

   The URL it prints ends in `#<network id>`. That part identifies your network to the new device,
   so copy the command as a whole.

2. On the new device, run it:

   ```sh
   agent-message relay join 'https://agent-message-relay.<account>.workers.dev#<network id>'
   ```

   It prints a pairing code and waits.

3. On the member device, approve the code within ten minutes:

   ```sh
   agent-message devices approve xxxx-xxxx-xxxx
   ```

The new device finishes joining by itself. Check with `agent-message relay status` on either one.

## Remove a device

```sh
agent-message devices revoke <device name>   # from another member
agent-message relay leave                    # on the device itself
```

A revoked device cannot rejoin with the same keys. To bring it back, run `agent-message relay leave`
on it, delete `identity.json` in its home directory (`~/.local/state/agent-message` by default) while
its node is stopped, and pair it again.

## Operating notes

- **One relay, one network.** To start over, run `bunx wrangler delete` in `packages/relay`, which removes
  the Worker and all of its data, and deploy again with a new token.
- **What the relay stores:** the roster (device names and public keys), pending pairing requests,
  and encrypted envelopes for devices that are offline, for at most seven days.
- **What it can see:** which device sends to which, when, and how large. Not the content.
- **Losing every device** means losing the network: there is no recovery path other than founding a new one.
- **Local development:** `bunx wrangler dev --var BOOTSTRAP_TOKEN:<token>` runs a relay on localhost,
  which `agent-message relay init http://localhost:8787` accepts.
