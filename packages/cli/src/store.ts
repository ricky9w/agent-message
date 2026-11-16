import { Database } from "bun:sqlite";
import { type Envelope, MESSAGE_TTL_MS, type Message, type RosterEntry } from "@agent-message/protocol";

/** A session known to this node. `harness` and `session` together identify it; `name` is its address. */
export type Agent = {
  name: string;
  harness: string;
  session: string;
  cwd: string;
  /** False once the harness reported that the session ended. */
  open: boolean;
  /** When the session last registered, in milliseconds since the Unix epoch. */
  seenAt: number;
};

/** How long delivered messages and idle agents are remembered. */
const HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents (
    name TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    session TEXT NOT NULL,
    cwd TEXT NOT NULL,
    open INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    UNIQUE (harness, session)
  );
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    recipient TEXT NOT NULL,
    message TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS messages_pending ON messages (recipient, seq) WHERE delivered_at IS NULL;
  CREATE TABLE IF NOT EXISTS outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    envelope TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS roster (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type AgentRow = { name: string; harness: string; session: string; cwd: string; open: number; seen_at: number };
const toAgent = ({ seen_at, open, ...row }: AgentRow): Agent => ({ ...row, open: open === 1, seenAt: seen_at });

/**
 * Durable state of a node: agents, their inboxes, envelopes waiting for the relay, and the device roster.
 * Nothing here records who is connected right now; that lives in memory only.
 */
export class Store {
  private readonly db: Database;

  /** Opens the database and holds it exclusively, so a second node on the same home fails here. */
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // Agents

  agents(): Agent[] {
    return this.db.query<AgentRow, []>("SELECT * FROM agents ORDER BY name").all().map(toAgent);
  }

  agent(name: string): Agent | undefined {
    const row = this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE name = ?").get(name);
    return row ? toAgent(row) : undefined;
  }

  agentBySession(harness: string, session: string): Agent | undefined {
    const row = this.db
      .query<AgentRow, [string, string]>("SELECT * FROM agents WHERE harness = ? AND session = ?")
      .get(harness, session);
    return row ? toAgent(row) : undefined;
  }

  /** Inserts the agent, or updates the one with this name (including handing the name to a new session). */
  saveAgent(agent: Agent): void {
    this.db
      .query(
        `INSERT INTO agents (name, harness, session, cwd, open, seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET harness = excluded.harness, session = excluded.session,
           cwd = excluded.cwd, open = excluded.open, seen_at = excluded.seen_at`,
      )
      .run(agent.name, agent.harness, agent.session, agent.cwd, agent.open ? 1 : 0, agent.seenAt);
  }

  /** Removes an agent that never received anything. Returns whether it was removed. */
  deleteAgentIfUnused(name: string): boolean {
    return (
      this.db
        .query("DELETE FROM agents WHERE name = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE recipient = ?)")
        .run(name, name).changes > 0
    );
  }

  // Inbox

  /** Stores a message for a local agent. Returns false if this id was already stored. */
  addMessage(recipient: string, message: Message): boolean {
    return (
      this.db
        .query("INSERT OR IGNORE INTO messages (id, recipient, message, sent_at) VALUES (?, ?, ?, ?)")
        .run(message.id, recipient, JSON.stringify(message), message.sentAt).changes > 0
    );
  }

  /** Returns the agent's undelivered messages in arrival order and marks them delivered. */
  takeMessages(recipient: string, now: number): Message[] {
    const rows = this.db
      .query<{ message: string }, [number, string]>(
        "UPDATE messages SET delivered_at = ? WHERE recipient = ? AND delivered_at IS NULL RETURNING message, seq",
      )
      .all(now, recipient) as { message: string; seq: number }[];
    return rows.sort((a, b) => a.seq - b.seq).map((row) => JSON.parse(row.message) as Message);
  }

  pendingCount(recipient: string): number {
    return this.db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM messages WHERE recipient = ? AND delivered_at IS NULL")
      .get(recipient)!.n;
  }

  // Outbox

  addOutbox(envelope: Envelope): void {
    this.db
      .query("INSERT OR IGNORE INTO outbox (id, envelope, expires) VALUES (?, ?, ?)")
      .run(envelope.id, JSON.stringify(envelope), envelope.expires);
  }

  outbox(): Envelope[] {
    return this.db
      .query<{ envelope: string }, []>("SELECT envelope FROM outbox ORDER BY seq")
      .all()
      .map((row) => JSON.parse(row.envelope) as Envelope);
  }

  removeOutbox(id: string): void {
    this.db.query("DELETE FROM outbox WHERE id = ?").run(id);
  }

  // Roster and settings

  roster(): RosterEntry[] {
    return this.db
      .query<{ entry: string }, []>("SELECT entry FROM roster ORDER BY seq")
      .all()
      .map((row) => JSON.parse(row.entry) as RosterEntry);
  }

  appendRoster(entries: RosterEntry[], from: number): void {
    const insert = this.db.query("INSERT INTO roster (seq, entry) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const [index, entry] of entries.entries()) insert.run(from + index, JSON.stringify(entry));
    })();
  }

  get(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  }

  set(key: string, value: string): void {
    this.db
      .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Forgets the relay, the roster and anything still waiting to be relayed. */
  clearNetwork(): void {
    this.db.exec("DELETE FROM roster; DELETE FROM outbox; DELETE FROM meta WHERE key = 'relay'");
  }

  /** Drops expired and old rows. `attached` names agents that must be kept regardless of age. */
  prune(now: number, attached: ReadonlySet<string>): void {
    this.db.query("DELETE FROM messages WHERE delivered_at IS NULL AND sent_at < ?").run(now - MESSAGE_TTL_MS);
    this.db.query("DELETE FROM messages WHERE delivered_at < ?").run(now - HISTORY_MS);
    this.db.query("DELETE FROM outbox WHERE expires < ?").run(now);
    for (const agent of this.agents()) {
      if (agent.seenAt < now - HISTORY_MS && !attached.has(agent.name)) this.deleteAgentIfUnused(agent.name);
    }
  }
}
