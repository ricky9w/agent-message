/** Writes a timestamped line to stderr, which the node redirects to its log file. */
export function log(message: string, error?: unknown): void {
  const detail = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
  console.error(`${new Date().toISOString()} ${message}${detail}`);
}
