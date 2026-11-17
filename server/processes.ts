import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { HomeHolder } from "./adapter";

/**
 * The homes in `homes` a process was started with, by the line for it in `ps -E` (its command, then
 * its environment, space-separated): one of `variables` (`PI_CODING_AGENT_DIR`, say) set to exactly
 * that path. A command that only mentions one may match too, which only makes a move wait.
 */
export function homesInEnvironment(line: string, homes: readonly string[], variables: readonly string[]): string[] {
  const has = (needle: string) => {
    for (let at = line.indexOf(needle); at >= 0; at = line.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if ((at === 0 || /\s/.test(line[at - 1]!)) && (end === line.length || /\s/.test(line[end]!))) return true;
    }
    return false;
  };
  return homes.filter((home) => variables.some((variable) => has(`${variable}=${home}`)));
}

/** One process: its PID, its command's name, and its command then its environment, space-separated. */
export type ProcessEntry = { pid: number; command: string; line: string };

/** A `ps -o pid=,command=` line as an entry; null for one without a leading PID. */
export function parsePsLine(text: string): ProcessEntry | null {
  const match = /^\s*(\d+)\s+(\S.*)$/.exec(text);
  if (!match) return null;
  const line = match[2]!;
  return { pid: Number(match[1]), command: basename(line.split(/\s/, 1)[0]!), line };
}

/** "puma (PID 4242) and node (PID 4250)": `holders` by PID, the first three named. */
export function heldBy(holders: readonly HomeHolder[]): string {
  const names = [...holders].sort((a, b) => a.pid - b.pid).map(({ pid, command }) => `${command || "a process"} (PID ${pid})`);
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/**
 * Calls `visit` with each of the user's processes: its PID, its command's name, and one line of its
 * command then its environment. macOS lists them with `ps -E` (only one's own processes show their
 * environment, which is all this needs); Linux reads `/proc`. Streamed, since every environment
 * together runs to megabytes.
 */
export async function eachProcessEnvironment(visit: (entry: ProcessEntry) => void): Promise<void> {
  if (process.platform === "linux") {
    for (const pid of await readdir("/proc").catch(() => [] as string[])) {
      if (!/^\d+$/.test(pid)) continue;
      const environ = await readFile(join("/proc", pid, "environ"), "utf8").catch(() => null);
      if (!environ) continue;
      const command = (await readFile(join("/proc", pid, "comm"), "utf8").catch(() => "")).trim();
      visit({ pid: Number(pid), command, line: ` ${environ.split("\0").join(" ")}` });
    }
    return;
  }
  if (process.platform !== "darwin") throw new Error(`ZeroSub can't tell which processes use a home on ${process.platform}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/ps", ["-xEww", "-o", "pid=,command="], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8").slice(0, 2_000)));
    createInterface({ input: child.stdout }).on("line", (text) => {
      const entry = parsePsLine(text);
      if (entry) visit(entry);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`couldn't list running processes (${signal === "SIGKILL" ? "timed out" : stderr.trim() || `exit ${code}`})`));
    });
  });
}


/** `ip=` and `loc=` from a `/cdn-cgi/trace` answer (one `key=value` a line). */
export function parseTrace(text: string): { ip: string; country: string | null } | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const ip = fields.get("ip");
  return ip ? { ip, country: fields.get("loc") || null } : null;
}

