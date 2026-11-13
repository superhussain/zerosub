import { readFile } from "node:fs/promises";
import { run } from "./process";

export interface ProcessRow {
  pid: number;
  ppid: number;
  ageMs: number;
  args: string;
}

export interface SessionProcess extends ProcessRow {
  agentId: string;
}

export type LeftoverReason = "archived" | "closed" | "unknown" | "superseded";

export interface Leftover {
  pid: number;
  agentId: string;
  reason: LeftoverReason;
}

export interface AgentStatus {
  archived: boolean;
  status: string;
}

export const MIN_AGE_MS = 60_000;
export const UNKNOWN_AGE_MS = 600_000;
export const SUPERSEDED_GAP_MS = 30_000;

const PS_TIMEOUT_MS = 10_000;

/** Reads ps's `[[dd-]hh:]mm:ss` elapsed time as milliseconds. */
export function parseEtime(value: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const part = (index: number) => Number(match[index] ?? 0);
  return (((part(1) * 24 + part(2)) * 60 + part(3)) * 60 + part(4)) * 1000;
}

/** Parses `ps -o pid=,ppid=,etime=,args=` output; lines that don't fit are skipped. */
export function parsePs(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const [, pid, ppid, etime, args] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line) ?? [];
    const ageMs = etime === undefined ? null : parseEtime(etime);
    if (pid && ppid && args !== undefined && ageMs !== null) rows.push({ pid: Number(pid), ppid: Number(ppid), ageMs, args });
  }
  return rows;
}

export function isClaudeSession(args: string): boolean {
  return /claude/i.test(args) && /--output-format[= ]stream-json/.test(args) && /--input-format[= ]stream-json/.test(args);
}

/** Every pid below `pid` in the process tree. */
export function descendants(rows: readonly ProcessRow[], pid: number): number[] {
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of rows) {
      if (row.ppid === parent && !found.includes(row.pid)) {
        found.push(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return found;
}

/** The session processes Paseo should have ended: see the rule table in the job's spec. */
export function findLeftovers(
  sessions: readonly SessionProcess[],
  agents: ReadonlyMap<string, AgentStatus>,
  minAgeMs = MIN_AGE_MS,
): Leftover[] {
  const newestAge = new Map<string, number>();
  for (const session of sessions) {
    newestAge.set(session.agentId, Math.min(newestAge.get(session.agentId) ?? Infinity, session.ageMs));
  }
  const leftovers: Leftover[] = [];
  for (const { pid, agentId, ageMs } of sessions) {
    if (ageMs < minAgeMs) continue;
    const agent = agents.get(agentId);
    let reason: LeftoverReason | null = null;
    if (!agent) reason = ageMs >= UNKNOWN_AGE_MS ? "unknown" : null;
    else if (agent.archived) reason = "archived";
    else if (agent.status === "closed") reason = "closed";
    else if (ageMs - (newestAge.get(agentId) ?? ageMs) >= SUPERSEDED_GAP_MS) reason = "superseded";
    if (reason) leftovers.push({ pid, agentId, reason });
  }
  return leftovers;
}

/** The agent id in a process's environment text. On macOS the command line comes first, so the last match is the environment's. */
export const agentIdFrom = (text: string): string | null =>
  [...text.matchAll(/(?:^|[\s\0])PASEO_AGENT_ID=([^\s\0]+)/g)].at(-1)?.[1] ?? null;

async function agentIdOf(pid: number): Promise<string | null> {
  const text =
    process.platform === "linux"
      ? await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "")
      : (await run("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { timeoutMs: PS_TIMEOUT_MS })).stdout;
  return agentIdFrom(text);
}

async function listProcesses(): Promise<ProcessRow[] | null> {
  const result = await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,etime=,args="], { timeoutMs: PS_TIMEOUT_MS });
  return result.code === 0 ? parsePs(result.stdout) : null;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/** What `resolve` says about an agent the list left out: its status, `"gone"`, or `null` for no answer yet. */
export type AgentLookup = (agentId: string) => Promise<AgentStatus | "gone" | null>;

/**
 * Stops the leftover Claude session processes of Paseo's daemon, with their descendants: SIGTERM,
 * then SIGKILL for any that outlast `graceMs`. Stops nothing when `ps` fails.
 */
export async function reapLeftovers(
  agents: ReadonlyMap<string, AgentStatus>,
  options: { daemonPids?: readonly number[]; minAgeMs?: number; graceMs?: number; resolve?: AgentLookup } = {},
): Promise<Leftover[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  const daemonPids = (options.daemonPids ?? [process.ppid, process.pid]).filter((pid) => pid !== 1);
  const rows = await listProcesses();
  if (!rows) return [];
  const sessions: SessionProcess[] = [];
  for (const row of rows) {
    if (!daemonPids.includes(row.ppid) || !isClaudeSession(row.args)) continue;
    const agentId = await agentIdOf(row.pid);
    if (agentId) sessions.push({ ...row, agentId });
  }
  const known = new Map(agents);
  const unanswered = new Set<string>();
  for (const agentId of new Set(sessions.map((session) => session.agentId))) {
    if (known.has(agentId) || !options.resolve) continue;
    const found = await options.resolve(agentId);
    if (found === null) unanswered.add(agentId);
    else if (found !== "gone") known.set(agentId, found);
  }
  const leftovers = findLeftovers(
    sessions.filter((session) => !unanswered.has(session.agentId)),
    known,
    options.minAgeMs,
  );
  const targets = leftovers.flatMap(({ pid }) => [pid, ...descendants(rows, pid)]);
  for (const pid of targets) signal(pid, "SIGTERM");
  if (targets.length === 0) return leftovers;
  await new Promise((resolve) => setTimeout(resolve, options.graceMs ?? 5_000));
  const after = await listProcesses();
  for (const pid of targets) {
    const before = rows.find((row) => row.pid === pid);
    if (after?.some((row) => row.pid === pid && row.ppid === before?.ppid)) signal(pid, "SIGKILL");
  }
  return leftovers;
}
