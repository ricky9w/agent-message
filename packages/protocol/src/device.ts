import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { base32, base64url, concat, fromBase64url, sha256 } from "./encoding.ts";

/** A device's public identity. Keys are base64url-encoded raw public keys. */
export type Device = {
  /** Fingerprint of both public keys; see {@link deviceId}. */
  id: string;
  name: string;
  /** Ed25519 key that signs roster entries, relay requests and message payloads. */
  signKey: string;
  /** X25519 key that messages are encrypted to. */
  kexKey: string;
};

/** A device's private keys, base64url-encoded (Ed25519 as PKCS#8, X25519 raw). */
export type DeviceSecret = { signKey: string; kexKey: string };

export type Identity = { device: Device; secret: DeviceSecret };

/** HPKE (RFC 9180) base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM. */
export const hpke = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });

const ED25519 = "Ed25519";

export async function createIdentity(name: string): Promise<Identity> {
  const sign = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const kex = await hpke.kem.generateKeyPair();
  const signKey = base64url(new Uint8Array((await crypto.subtle.exportKey("raw", sign.publicKey)) as ArrayBuffer));
  const kexKey = base64url(new Uint8Array(await hpke.kem.serializePublicKey(kex.publicKey)));
  return {
    device: { id: await deviceId(signKey, kexKey), name, signKey, kexKey },
    secret: {
      signKey: base64url(new Uint8Array((await crypto.subtle.exportKey("pkcs8", sign.privateKey)) as ArrayBuffer)),
      kexKey: base64url(new Uint8Array(await hpke.kem.serializePrivateKey(kex.privateKey))),
    },
  };
}

/** A device id is the first 20 bytes of SHA-256(signKey ‖ kexKey), in base32 (32 characters). */
export async function deviceId(signKey: string, kexKey: string): Promise<string> {
  const digest = await sha256(concat(fromBase64url(signKey), fromBase64url(kexKey)));
  return base32(digest.subarray(0, 20));
}

/** Length of a pairing code: a device id prefix carrying 60 bits. */
export const PAIRING_CODE_LENGTH = 12;

/** The code a new device shows during pairing: the start of its id, grouped for reading aloud. */
export const pairingCode = (id: string): string => id.slice(0, PAIRING_CODE_LENGTH).replace(/(.{4})(?=.)/g, "$1-");

/** Strips grouping and case from a typed pairing code. */
export const normalizePairingCode = (code: string): string => code.toLowerCase().replace(/[^a-z2-7]/g, "");

export async function sign(secret: DeviceSecret, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", fromBase64url(secret.signKey), ED25519, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign(ED25519, key, bytes)));
}

export async function verify(signKey: string, bytes: Uint8Array<ArrayBuffer>, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64url(signKey), ED25519, false, ["verify"]);
    return await crypto.subtle.verify(ED25519, key, fromBase64url(signature), bytes);
  } catch {
    return false;
  }
}
