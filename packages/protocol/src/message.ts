/** Maximum message body size in UTF-8 bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/** How long an undelivered message is kept before it is dropped, in milliseconds. */
export const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A message between two agents. `from` and `to` are full `agent@device` addresses. */
export type Message = {
  id: string;
  from: string;
  to: string;
  body: string;
  /** Id of the message this one answers. */
  replyTo?: string;
  /** Milliseconds since the Unix epoch, by the sending device's clock. */
  sentAt: number;
};

/** How an agent on some device appears to its peers. */
export type AgentInfo = {
  name: string;
  harness: string;
  /** Working directory of the session, for telling agents apart. */
  cwd: string;
  /** Whether a live session is attached and messages are pushed to it. */
  online: boolean;
};
