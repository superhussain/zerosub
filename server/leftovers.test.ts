import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  agentIdFrom,
  descendants,
  findLeftovers,
  isClaudeSession,
  parseEtime,
  parsePs,
  reapLeftovers,
  sameProcess,
  type AgentStatus,
  type SessionProcess,
} from "./leftovers";

const NOW = Date.parse("2026-11-13T14:52:00");
const since = (at: string) => NOW - Date.parse(at);
const row = (pid: number, agentId: string, at: string): SessionProcess => ({ pid, ppid: 1, agentId, ageMs: since(at), args: "" });
const live = new Map<string, AgentStatus>([["3fe7e8f2", { archived: false, status: "idle" }]]);

describe("parsing", () => {
  it("reads elapsed times", () => {
    expect(parseEtime("05:07")).toBe(307_000);
    expect(parseEtime("01:05:07")).toBe(3_907_000);
    expect(parseEtime("2-01:05:07")).toBe(176_707_000);
    expect(parseEtime("soon")).toBeNull();
  });

  it("parses ps lines and finds descendants", () => {
    const rows = parsePs("  10     1 01:00 claude --x\n  11    10 00:30 mcp a b\n  12    11 00:10 leaf\nbad line\n");
    expect(rows.map((r) => [r.pid, r.ppid, r.ageMs, r.args])).toEqual([
      [10, 1, 60_000, "claude --x"],
      [11, 10, 30_000, "mcp a b"],
      [12, 11, 10_000, "leaf"],
    ]);
    expect(descendants(rows, 10)).toEqual([11, 12]);
  });

  it("recognises stream-json Claude sessions", () => {
    expect(isClaudeSession("claude --output-format stream-json --input-format=stream-json")).toBe(true);
    expect(isClaudeSession("claude --output-format stream-json")).toBe(false);
    expect(isClaudeSession("node --output-format stream-json --input-format stream-json")).toBe(false);
  });

  it("sameProcess matches pid and start time", () => {
    const before = { pid: 4102, ppid: 4101, ageMs: 10_000, args: "" };
    expect(sameProcess(before, 1_000_000, { ...before, ppid: 1, ageMs: 15_400 }, 1_005_000)).toBe(true);
    expect(sameProcess(before, 1_000_000, { ...before, ageMs: 1_000 }, 1_005_000)).toBe(false);
    expect(sameProcess(before, 1_000_000, { ...before, pid: 4103, ageMs: 15_400 }, 1_005_000)).toBe(false);
  });
});

describe("agentIdFrom", () => {
  it("takes the environment's id, not one in the command line", () => {
    expect(agentIdFrom("claude --prompt PASEO_AGENT_ID=fake HOME=/x PASEO_AGENT_ID=real PATH=/bin")).toBe("real");
    expect(agentIdFrom("A=1\0PASEO_AGENT_ID=real\0B=2")).toBe("real");
    expect(agentIdFrom("claude HOME=/x")).toBeNull();
  });
});

describe("findLeftovers", () => {
  const sessions = [
    row(18018, "3fe7e8f2", "2026-11-12T13:24:47"),
    row(96677, "3fe7e8f2", "2026-11-12T14:30:27"),
    row(65843, "3fe7e8f2", "2026-11-12T16:26:14"),
    row(99668, "3fe7e8f2", "2026-11-13T10:58:09"),
    row(3623, "3fe7e8f2", "2026-11-13T14:42:58"),
    row(3624, "3fe7e8f2", "2026-11-13T14:42:58"),
  ];

  it("running example: supersedes the four earlier resumes and keeps the current pair", () => {
    expect(findLeftovers(sessions, live)).toEqual(
      [18018, 96677, 65843, 99668].map((pid) => ({ pid, agentId: "3fe7e8f2", reason: "superseded" })),
    );
  });

  it("closed archived unknown: archived and closed lose everything, unlisted only old ones", () => {
    const agents = new Map<string, AgentStatus>([
      ["a", { archived: true, status: "idle" }],
      ["c", { archived: false, status: "closed" }],
    ]);
    const all = [
      { ...row(1, "a", "2026-11-13T14:51:00") },
      { ...row(2, "c", "2026-11-13T14:51:00") },
      { ...row(3, "gone", "2026-11-13T14:51:00") },
      { ...row(4, "gone", "2026-11-13T14:30:00") },
    ];
    expect(findLeftovers(all, agents)).toEqual([
      { pid: 1, agentId: "a", reason: "archived" },
      { pid: 2, agentId: "c", reason: "closed" },
      { pid: 4, agentId: "gone", reason: "unknown" },
    ]);
  });

  it("young processes are never returned, but still count as the newest", () => {
    const young = { ...row(9, "3fe7e8f2", "2026-11-13T14:51:30") };
    const old = { ...row(8, "3fe7e8f2", "2026-11-13T14:00:00") };
    expect(findLeftovers([old, young], live)).toEqual([{ pid: 8, agentId: "3fe7e8f2", reason: "superseded" }]);
    const closed = new Map<string, AgentStatus>([["3fe7e8f2", { archived: true, status: "idle" }]]);
    expect(findLeftovers([young], closed)).toEqual([]);
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === "win32")("reapLeftovers", () => {
  const fakeArgs = (script: string, extra: string[] = ["claude-fake", "--output-format", "stream-json", "--input-format", "stream-json"]) => [
    "-e",
    script,
    ...extra,
  ];
  const idle = "setInterval(()=>{},1e3)";
  const withChild = `console.log(require("child_process").spawn(process.execPath,["-e","${idle}"],{stdio:"ignore"}).pid);${idle}`;
  const start = (args: string[], env: Record<string, string>) =>
    spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 800));

  it("stops a fake session and its child, and leaves lookalikes alone", async () => {
    const agents = new Map<string, AgentStatus>([["test-agent", { archived: true, status: "idle" }]]);
    const session = start(fakeArgs(withChild), { PASEO_AGENT_ID: "test-agent" });
    const noAgent = start(fakeArgs(idle), {});
    const plainArgs = start(fakeArgs(idle, ["claude-fake"]), { PASEO_AGENT_ID: "test-agent" });
    const strangers = [noAgent, plainArgs];
    const child = Number(await new Promise<string>((resolve) => session.stdout!.once("data", (chunk) => resolve(String(chunk)))));
    await settle();
    const before = await reapLeftovers(agents, { daemonPids: [process.pid + 1_000_000], minAgeMs: 0 });
    expect(before).toEqual([]);
    expect(alive(session.pid!)).toBe(true);
    const stopped = await reapLeftovers(agents, { daemonPids: [process.pid], minAgeMs: 0, graceMs: 300 });
    expect(stopped).toEqual([{ pid: session.pid, agentId: "test-agent", reason: "archived" }]);
    await settle();
    expect(alive(session.pid!)).toBe(false);
    expect(alive(child)).toBe(false);
    for (const stranger of strangers) {
      expect(alive(stranger.pid!)).toBe(true);
      stranger.kill();
    }
  });

  it("kills a child that ignores SIGTERM once its session has exited", async () => {
    const stubborn = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1e3)';
    const agents = new Map<string, AgentStatus>([["test-agent", { archived: true, status: "idle" }]]);
    const session = start(
      fakeArgs(`console.log(require("child_process").spawn(process.execPath,["-e",${JSON.stringify(stubborn)}],{stdio:"ignore"}).pid);${idle}`),
      { PASEO_AGENT_ID: "test-agent" },
    );
    const child = Number(await new Promise<string>((resolve) => session.stdout!.once("data", (chunk) => resolve(String(chunk)))));
    try {
      await settle();
      await reapLeftovers(agents, { daemonPids: [process.pid], minAgeMs: 0, graceMs: 500 });
      await settle();
      expect(alive(child)).toBe(false);
    } finally {
      try {
        process.kill(child, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("resolves agents the list left out: a live one keeps its process, an unanswered one is skipped, a gone one waits out the 10 minute floor", async () => {
    const run = async (resolve: (id: string) => Promise<AgentStatus | "gone" | null>) => {
      const session = start(fakeArgs(idle), { PASEO_AGENT_ID: "background-agent" });
      await settle();
      const stopped = await reapLeftovers(new Map(), { daemonPids: [process.pid], minAgeMs: 0, graceMs: 300, resolve });
      await settle();
      const survived = alive(session.pid!);
      session.kill();
      return { stopped, survived };
    };
    expect((await run(async () => ({ archived: false, status: "idle" }))).stopped).toEqual([]);
    expect((await run(async () => null)).survived).toBe(true);
    const gone = await run(async () => "gone");
    expect(gone.stopped).toEqual([]);
    expect(gone.survived).toBe(true);
  }, 20_000);
});
