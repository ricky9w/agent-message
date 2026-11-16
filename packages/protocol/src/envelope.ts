import { type Device, hpke, type Identity, sign, verify } from "./device.ts";
import { base64url, canonical, concat, fromBase64url, fromUtf8, utf8 } from "./encoding.ts";
import type { AgentInfo, Message } from "./message.ts";

/** Largest envelope a relay accepts, in bytes of its JSON form. */
export const MAX_ENVELOPE_BYTES = 128 * 1024;

/** What devices say to each other. Only the two devices involved can read it. */
export type Payload =
  | { type: "message"; message: Message }
  /** The sender's complete list of agents, replacing any earlier one. */
  | { type: "agents"; agents: AgentInfo[]; at: number };

/** What a relay sees and routes: device ids, a deadline, and an opaque box. */
export type Envelope = {
  id: string;
  /** Sending device id. */
  from: string;
  /** Receiving device id. */
  to: string;
  /** When the relay may drop it undelivered, in milliseconds since the Unix epoch. */
  expires: number;
  /** Dropped instead of queued when the receiver is not connected. */
  ephemeral?: true;
  /** base64url of the HPKE encapsulated key followed by the ciphertext. */
  box: string;
};

const INFO = utf8("agent-message/v1/envelope");
const ENC_BYTES = 32;

const header = ({ box: _, ...rest }: Envelope) => utf8(canonical(rest));
const signedBytes = (aad: Uint8Array, payload: string) => concat(aad, Uint8Array.of(0), utf8(payload));

/** Signs `payload` as `from` and encrypts it to `to`. The envelope header is bound as associated data. */
export async function sealEnvelope(
  payload: Payload,
  from: Identity,
  to: Device,
  options: { id: string; expires: number; ephemeral?: true },
): Promise<Envelope> {
  const envelope: Envelope = { ...options, from: from.device.id, to: to.id, box: "" };
  const aad = header(envelope);
  const body = JSON.stringify(payload);
  const plaintext = utf8(JSON.stringify({ body, sig: await sign(from.secret, signedBytes(aad, body)) }));
  const recipientPublicKey = await hpke.kem.deserializePublicKey(fromBase64url(to.kexKey).buffer);
  const { enc, ct } = await hpke.seal({ recipientPublicKey, info: INFO }, plaintext.buffer, aad.buffer);
  return { ...envelope, box: base64url(concat(new Uint8Array(enc), new Uint8Array(ct))) };
}

/** Decrypts an envelope addressed to `self` and checks that `sender` signed it. Throws otherwise. */
export async function openEnvelope(envelope: Envelope, self: Identity, sender: Device): Promise<Payload> {
  if (envelope.to !== self.device.id || envelope.from !== sender.id) throw new Error("Envelope is misaddressed");
  const aad = header(envelope);
  const box = fromBase64url(envelope.box);
  const recipientKey = await hpke.kem.deserializePrivateKey(fromBase64url(self.secret.kexKey).buffer);
  const plaintext = await hpke.open(
    { recipientKey, enc: box.slice(0, ENC_BYTES).buffer, info: INFO },
    box.slice(ENC_BYTES).buffer,
    aad.buffer,
  );
  const { body, sig } = JSON.parse(fromUtf8(new Uint8Array(plaintext))) as { body: string; sig: string };
  if (!(await verify(sender.signKey, signedBytes(aad, body), sig))) throw new Error("Envelope signature is invalid");
  return JSON.parse(body) as Payload;
}
