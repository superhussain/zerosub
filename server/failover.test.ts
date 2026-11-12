import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem, FamilyAdapter, LimitHit, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { detectClaudeLimit } from "./limits";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type OpenCodeFork, type StoredAccount, type StoredState } from "./state";
import { buildTranscript, continuationPrompt } from "./handoff";
import { preferences } from "../shared/preferences";

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";
const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-failover-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root; // saved usage lands here, never in the real ~/.paseo
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function account(id: string, label: string, kind: "main" | "managed") {
  return { id, family: "claude" as const, label, kind, home: kind === "main" ? null : join(tmpdir(), id), createdAt: "2026-09-23T00:00:00.000Z" };
}

/** A Claude adapter whose every failed turn is a session limit resetting at `resetsAt`. */
function claudeAdapter(hit: () => LimitHit): FamilyAdapter {
  const reading = (): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null });
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async () => null,
    usage: async () => reading(),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: (event: { outcome: { kind: string } }) => (event.outcome.kind === "failed" ? hit() : null),
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

/** A row of the agent's timeline as Paseo pages it: the item, and the turn Paseo tagged it with. */
type Row = { item: AgentTimelineItem; turnId?: string };

/** The rows Paseo tags with `turnId` while that turn runs. */
function inTurn(turnId: string, ...items: AgentTimelineItem[]): Row[] {
  return items.map((item) => ({ item, turnId }));
}

/** `recent` is what Paseo hands back when the plugin pages the agent's timeline from its tail, or how it answers. */
function fakePaseo(recent: readonly Row[] | (() => Promise<{ entries: readonly Row[] }>) = []) {
  const sent: string[] = [];
  const notes: Array<{ from: string | null; to: string; outcome: string; detail: string | null }> = [];
  const refetches: Array<{ direction?: string; limit?: number }> = [];
  const agent = { id: AGENT, provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: "2026-09-23T07:00:00.000Z" };
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => ({ agent }),
        send: async (text: string) => void sent.push(text),
        timeline: {
          append: async (item: { data: { from: string | null; to: string; outcome: string; detail: string | null } }) =>
            void notes.push(item.data),
          refetch: async (options: { direction?: string; limit?: number } = {}) => {
            refetches.push(options);
            return typeof recent === "function" ? recent() : { entries: recent };
          },
        },
      }),
    },
  };
  return { paseo, sent, notes, refetches };
}

interface SetUpOptions {
  /** How `paseo agent reload` ends. */
  reload?: "works" | "fails" | "times out";
  /** Reads turns with a real detector instead of taking every failed turn for a limit. */
  detectLimit?: FamilyAdapter["detectLimit"];
  /** The tail of the agent's timeline as Paseo returns it when asked. */
  recent?: Parameters<typeof fakePaseo>[0];
  /** What every usage reading returns. */
  usage?: () => UsageRead;
}

async function setUp(state: Partial<StoredState>, hit: () => LimitHit, options: SetUpOptions = {}) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  const reopened: string[] = [];
  const fake = fakePaseo(options.recent);
  const context = { paseo: fake.paseo } as never;
  // Paseo asks for the new session's environment before it closes the old session, so the hook has
  // run by the time `paseo agent reload` returns, even when the reload then failed.
  const reopenedSession = () =>
    service.onSessionOpen({ agentId: AGENT, provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never, context);
  const reopener = {
    locate: async () => "/usr/local/bin/paseo",
    reopen: async (id: string) => {
      reopened.push(id);
      await reopenedSession();
      if (options.reload === "fails") {
        return { ok: false as const, error: "Timed out closing previous session during refresh", timedOut: false };
      }
      if (options.reload === "times out") return { ok: false as const, error: "Command failed: paseo agent reload", timedOut: true };
      return { ok: true as const };
    },
  };
  const families = { resolve: async () => ({ claude: "claude" as const }) };
  const claude = {
    ...claudeAdapter(hit),
    ...(options.detectLimit ? { detectLimit: options.detectLimit } : {}),
    ...(options.usage ? { usage: async () => options.usage!() } : {}),
  };
  const service = new Service(
    { claude, codex: claudeAdapter(hit) },
    store,
    families as unknown as FamilyResolver,
    reopener as unknown as Reopener,
  );
  const limitTurn = () =>
    service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
      context,
    );
  return { service, store, reopened, limitTurn, ...fake };
}

const inFuture = () => new Date(Date.now() + 30 * 60_000).toISOString();
const inPast = () => new Date(Date.now() - 60_000).toISOString();

describe("failover", () => {
  it("blames the CLI login for a session ZeroSub never routed, even when the agent is bound elsewhere", async () => {
    // Today's incident: the agent's session predates zerosub, and a switch to "hello" was waiting.
    const { store, reopened, sent, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: new Date().toISOString() } },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" }),
    );
    await limitTurn();
    const state = await store.read();
    expect(state.accounts.find((a) => a.id === MAIN)?.limitedUntil).not.toBeNull();
    expect(state.accounts.find((a) => a.id === HELLO)?.limitedUntil).toBeNull();
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
    expect(sent).toHaveLength(1);
  });

  it("moves on again when the next account runs out too", async () => {
    let resetsAt = inPast(); // marketing's window has already reset when hello runs out
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt, message: "You've hit your session limit" }),
    );
    await limitTurn(); // marketing → hello
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    resetsAt = inFuture();
    await limitTurn(); // hello runs out → back to marketing
    expect(reopened).toHaveLength(2);
    expect(notes.at(-1)).toMatchObject({ from: "hello", to: "marketing", outcome: "switched" });
  });

  it("explains in the timeline when it stops switching an agent that keeps bouncing", async () => {
    const { reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inPast(), message: "You've hit your session limit" }),
    );
    for (let turn = 0; turn < 5; turn += 1) await limitTurn();
    expect(reopened).toHaveLength(4);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
    expect(notes.at(-1)?.detail).toMatch(/stopped switching it for now/);
  });

  it("doesn't blame the new account for the old one's limit when a message fails before its turn starts", async () => {
    // A real incident: marketing's weekly limit moved the agent to hello, then a message hit a closed
    // session. Paseo never started that turn, so the timeline still ended with marketing's notice.
    const notice = "You've hit your weekly limit · resets Sep 25 at 3:30pm (Asia/Calcutta)";
    const { service, store, reopened, notes, paseo } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => {
        throw new Error("unused: the real detector reads the turns");
      },
      { detectLimit: detectClaudeLimit },
    );
    const context = { paseo } as never;
    const agent = { id: AGENT, provider: "claude" };
    const earlier: AgentTimelineItem[] = [
      { type: "user_message", text: "fix the bug" },
      { type: "assistant_message", text: notice },
    ];
    await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: earlier } as never, context);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);

    const closed = "Claude session is closed";
    await service.onTurnEnded(
      {
        agent,
        turnId: null,
        outcome: { kind: "failed", error: { message: closed } },
        timeline: [...earlier, { type: "assistant_message", text: `[System Error] ${closed}` }],
      } as never,
      context,
    );
    expect((await store.read()).accounts.find((a) => a.id === HELLO)?.limitedUntil).toBeNull();
    expect(reopened).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  it("switches and continues on Claude Code's 5-hour limit notice", async () => {
    // Claude Code 2.1.312 calls the session limit the "5-hour limit" (#28). Paseo 0.12 sends the turn
    // with the hook; 0.13 and later send none, so it's read from the agent's timeline.
    const saoPaulo = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const apostrophe of ["'", "’"]) {
      for (const hookSendsTurn of [true, false]) {
        const turn: AgentTimelineItem[] = [
          { type: "user_message", text: "fix the bug" },
          { type: "assistant_message", text: `You${apostrophe}ve hit your 5-hour limit · resets 7pm (America/Sao_Paulo)` },
        ];
        const { service, store, reopened, sent, notes, paseo } = await setUp(
          {
            accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
            defaults: { claude: MAIN, codex: null },
            bindings: {},
            sessions: {},
          },
          () => {
            throw new Error("unused: the real detector reads the turns");
          },
          { detectLimit: detectClaudeLimit, recent: inTurn("t1", ...turn) },
        );
        const before = Date.now();
        const event = { agent: { id: AGENT, provider: "claude" }, turnId: "t1", outcome: { kind: "completed" }, timeline: hookSendsTurn ? turn : [] };
        await service.onTurnEnded(event as never, { paseo } as never);
        const state = await store.read();
        expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
        expect(reopened).toEqual([AGENT]);
        expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched", continued: true });
        expect(sent).toEqual([preferences.schema.parse({}).continuePrompt]);
        // marketing is out until the next 7pm in São Paulo, whatever the daemon's own zone.
        const marketing = state.accounts.find((a) => a.id === MAIN);
        expect(marketing?.limitKind).toBe("window");
        const until = Date.parse(marketing?.limitedUntil ?? "");
        expect(saoPaulo.format(until)).toBe("19:00");
        expect(until).toBeGreaterThan(before);
        expect(until).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
      }
    }
  });

  // Paseo 0.13 (getpaseo/paseo#7477) stopped copying the conversation into turn-ended hooks: `timeline`
  // is always `[]`. Claude reports its limits as an ordinary reply, so the plugin has to page the
  // tail of the timeline itself or it never sees them again.
  describe("when the hook arrives without the turn's timeline", () => {
    const notice = "You've hit your session limit · resets 3pm (UTC)";
    const twoAccounts = () => ({
      accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
      defaults: { claude: MAIN, codex: null },
      sessions: {},
    });
    const unused = () => {
      throw new Error("unused: the real detector reads the turns");
    };
    const agent = { id: AGENT, provider: "claude" };

    it("reads the finished turn from Paseo and still switches on a limit", async () => {
      const recent = inTurn("t1", { type: "user_message", text: "fix the bug" }, { type: "assistant_message", text: notice });
      const { service, store, reopened, notes, refetches, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: [] } as never, { paseo } as never);
      expect(refetches).toHaveLength(1);
      expect(refetches[0]).toMatchObject({ direction: "tail" });
      expect(refetches[0]?.limit).toBeGreaterThan(0);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
      expect(reopened).toEqual([AGENT]);
      expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
    });

    it("trusts a timeline the hook did send instead of reading it again", async () => {
      // Paseo 0.12 still sends the turn; a second read would see older rows and could blame the account twice.
      const recent = inTurn("t1", { type: "assistant_message", text: notice });
      const { service, store, refetches, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      const sent: AgentTimelineItem[] = [
        { type: "user_message", text: "fix the bug" },
        { type: "assistant_message", text: "Done, all tests pass." },
      ];
      await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: sent } as never, { paseo } as never);
      expect(refetches).toHaveLength(0);
      expect((await store.read()).sessions[AGENT]?.accountId ?? MAIN).toBe(MAIN);
    });

    it("leaves Paseo alone for turns that never started, have no id, or were canceled", async () => {
      const recent = inTurn("t2", { type: "assistant_message", text: notice });
      const { service, store, refetches, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      const context = { paseo } as never;
      await service.onTurnEnded({ agent, turnId: null, outcome: { kind: "failed", error: { message: "Claude session is closed" } }, timeline: [] } as never, context);
      // Without an id there's nothing to tell this turn's rows by: untagged rows include replayed history.
      await service.onTurnEnded({ agent, outcome: { kind: "completed" }, timeline: [] } as never, context);
      await service.onTurnEnded({ agent, turnId: "t2", outcome: { kind: "canceled" }, timeline: [] } as never, context);
      expect(refetches).toHaveLength(0);
      expect((await store.read()).sessions[AGENT]?.accountId ?? MAIN).toBe(MAIN);
    });

    it("doesn't read an earlier turn's limit again", async () => {
      // The page reaches back into the turn that hit the limit. A turn Claude Code starts by itself,
      // such as after a background task finishes, has no message to stop at, so only the turn ids
      // keep the old notice (a reply, or Paseo's untagged error row) from moving the agent again.
      const endings: Row[][] = [
        inTurn("t1", { type: "assistant_message", text: notice }),
        [{ item: { type: "assistant_message", text: `[System Error] ${notice}` } }],
      ];
      for (const ending of endings) {
        const recent = [
          ...inTurn("t1", { type: "user_message", text: "fix the bug" }),
          ...ending,
          ...inTurn("t2", { type: "assistant_message", text: "The background build finished." }),
        ];
        const { service, store, reopened, notes, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
        await service.onTurnEnded({ agent, turnId: "t2", outcome: { kind: "completed" }, timeline: [] } as never, { paseo } as never);
        expect((await store.read()).accounts.find((a) => a.id === MAIN)?.limitedUntil).toBeNull();
        expect(reopened).toEqual([]);
        expect(notes).toEqual([]);
      }
    });

    it("doesn't take an earlier turn with the same id for this one", async () => {
      // Providers count turns per session, and some session restarts keep the timeline (a voice-mode
      // toggle does), so an earlier turn can carry this turn's id. The prompt between them ends the turn.
      const recent = [
        ...inTurn("autonomous-turn-2", { type: "assistant_message", text: notice }),
        ...inTurn("foreground-turn-1", { type: "user_message", text: "continue" }, { type: "assistant_message", text: "Restarted the build." }),
        ...inTurn("autonomous-turn-2", { type: "assistant_message", text: "The build finished." }),
      ];
      const { service, store, reopened, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      const turn = { agent, turnId: "autonomous-turn-2", outcome: { kind: "completed" }, timeline: [] };
      await service.onTurnEnded(turn as never, { paseo } as never);
      expect((await store.read()).accounts.find((a) => a.id === MAIN)?.limitedUntil).toBeNull();
      expect(reopened).toEqual([]);
    });

    it("still finds the limit when the next turn starts before the page is read", async () => {
      // Another plugin's follow-up, or a queued message, can start the next turn while the hook is on its way.
      const recent = [
        ...inTurn("t1", { type: "user_message", text: "fix the bug" }, { type: "assistant_message", text: notice }),
        ...inTurn("t2", { type: "user_message", text: "Try again." }),
      ];
      const { service, store, reopened, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: [] } as never, { paseo } as never);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
      expect(reopened).toEqual([AGENT]);
    });

    it("goes on with the turn's own failure when the page can't be read", async () => {
      const failed = { kind: "failed", error: { message: notice } };
      const recent = () => Promise.reject(new Error("The daemon went away"));
      const { service, store, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      await service.onTurnEnded({ agent, turnId: "t1", outcome: failed, timeline: [] } as never, { paseo } as never);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    });

    it("doesn't wait for a page that never comes", async () => {
      // The SDK would wait 60 s for an answer, holding up the switch and anything else waiting for the turn to end.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let asked = () => {};
        const reading = new Promise<void>((resolve) => (asked = resolve));
        const recent = () => {
          asked();
          return new Promise<never>(() => {});
        };
        const failed = { kind: "failed", error: { message: notice } };
        const { service, store, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
        const ended = service.onTurnEnded({ agent, turnId: "t1", outcome: failed, timeline: [] } as never, { paseo } as never);
        await Promise.race([reading, ended]); // the page is asked for, or the turn needed none
        await vi.advanceTimersByTimeAsync(10_000);
        await ended;
        expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("keeps an agent's session where it was when Paseo can't reload it", async () => {
    const openedAt = "2026-09-23T07:00:00.000Z";
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your weekly limit" }),
      { reload: "fails" },
    );
    await limitTurn();
    const state = await store.read();
    expect(reopened).toEqual([AGENT]);
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO); // where it goes when its session next opens
    expect(state.sessions[AGENT]).toEqual({ accountId: MAIN, family: "claude", openedAt });
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "pending" });
  });

  it("keeps the new session when the reload only ran out of time", async () => {
    // The daemon may still finish a reload that the command-line tool stopped waiting for.
    const { store, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your weekly limit" }),
      { reload: "times out" },
    );
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });
});

describe("forking to the other provider", () => {
  const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
  const MODES: Record<string, Array<{ id: string; label: string; colorTier: string }>> = {
    claude: [
      { id: "plan", label: "Plan Mode", colorTier: "planning" },
      { id: "default", label: "Always Ask", colorTier: "safe" },
      { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
      { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
    ],
    codex: [
      { id: "auto", label: "Default Permissions", colorTier: "moderate" },
      { id: "full-access", label: "Full Access", colorTier: "dangerous" },
    ],
  };

  /** `conversation` is the agent's timeline, which Paseo pages from its tail. `others` are the host's other agents. */
  async function setUpFork(
    modeId: string,
    conversation: readonly Row[] = [],
    labels: Record<string, string> = {},
    others: Array<Record<string, unknown>> = [],
    options: {
      prefs?: Record<string, unknown>;
      /** What `listAvailable` answers for OpenCode; omitted when the host has none. */
      opencodeAvailable?: boolean;
      /** What `listModels` answers for OpenCode. */
      catalog?: Array<Record<string, unknown>>;
      /** OpenCode's modes. */
      opencodeModes?: Array<{ id: string; label: string; colorTier?: string }>;
      /** No ChatGPT account is configured at all. */
      noChatGPT?: boolean;
      /** The source agent's status, for refusals the manual path checks before anything else. */
      sourceStatus?: string;
      /** The source agent's provider, for a source outside the Claude family. */
      sourceProvider?: string;
    } = {},
  ) {
    const store = new StateStore(join(root, "state.json"));
    /** Seams for the network boundary: a test can act between reads, or make a send or read throw. */
    const hooks: {
      onRefetch?: (id: string) => void;
      onRefresh?: (id: string) => void;
      onModes?: (provider: string) => void;
      send?: (id: string, text: string, messageId: string | undefined) => void;
      createdStatus?: string;
    } = {};
    await store.update((draft) =>
      Object.assign(draft, {
        accounts: options.noChatGPT
          ? [account(MAIN, "marketing", "main")]
          : [account(MAIN, "marketing", "main"), { ...account(CODEX_MAIN, "hello", "main"), family: "codex" }],
        defaults: { claude: MAIN, codex: options.noChatGPT ? null : CODEX_MAIN },
      }),
    );
    const source = {
      id: AGENT,
      provider: options.sourceProvider ?? "claude",
      status: options.sourceStatus ?? "idle",
      title: "Fix the build",
      model: "claude-opus-5-5",
      currentModeId: modeId,
      workspaceId: "ws-1",
      archivedAt: null,
      lastUserMessageAt: "2026-09-23T07:00:00.000Z",
      labels,
    };
    /** Every timeline read, so tests can count how many pages a check needed. */
    const timelineReads: Array<{ id: string; direction?: string }> = [];
    const epochOf = (id: string) => (id === AGENT ? sourceEpoch : "epoch-1");
    const agents: Array<Record<string, unknown>> = [source, ...others];
    const byId = new Map(agents.map((agent) => [agent.id as string, agent]));
    const created: Array<{ agentId: string; workspaceId?: string; idempotencyKey?: string; config: { provider: string; modeId?: string }; title: string; prompt?: string; labels: Record<string, string> }> = [];
    const notes: Array<{ to: string; outcome: string; toFamily: string | null; toProvider: string | null; delivery?: string; detail: string | null; continuedIn: { agentId: string } | null }> = [];
    /** Every prompt the plugin sent, and the message ID it was sent under. */
    const sends: Array<{ agentId: string; text: string; messageId?: string }> = [];
    /** Per-agent timelines in Paseo's canonical projection; the fake tags every turn it accepts. */
    const timelines = new Map<string, Array<{ item: AgentTimelineItem; turnId?: string; seqEnd: number }>>();
    let seq = 0;
    const setTimeline = (id: string, rows: readonly Row[]) =>
      timelines.set(id, rows.map((row) => ({ ...row, seqEnd: ++seq })));
    setTimeline(AGENT, conversation);
    /** Adds one turn to an agent's timeline, as Paseo would when the user types. */
    const addTurn = (id: string, item: AgentTimelineItem, clientMessageId?: string) => {
      const rows = timelines.get(id) ?? [];
      const entry = clientMessageId && item.type === "user_message" ? { ...item, clientMessageId } : item;
      rows.push({ item: entry, turnId: `turn-${++seq}`, seqEnd: ++seq });
      timelines.set(id, rows);
    };
    /** Makes the next source read fail, as a history gap does; `fork` gaps every other timeline. */
    const gap = { source: false, fork: false };
    let sourceEpoch = "epoch-1";
    const modes: Record<string, Array<{ id: string; label: string; colorTier?: string }>> = {
      ...MODES,
      opencode: options.opencodeModes ?? [
        { id: "build", label: "Build", colorTier: "moderate" },
        { id: "code", label: "Code", colorTier: "dangerous" },
      ],
    };
    const models: Record<string, Array<Record<string, unknown>>> = {
      claude: [{ id: "claude-opus-5-5", isDefault: true }],
      codex: [{ id: "gpt-5.6-sol", isDefault: true }],
      opencode: options.catalog ?? [
        { id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] },
      ],
    };
    const available = [{ provider: "claude", available: true }, { provider: "codex", available: true }];
    if (options.opencodeAvailable !== false) available.push({ provider: "opencode", available: true });
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      providers: {
        listAvailable: async () => ({ providers: available }),
        listModes: async (provider: string) => {
          hooks.onModes?.(provider);
          return { modes: modes[provider] };
        },
        listModels: async (provider: string) => ({ models: models[provider] }),
      },
      workspaces: {
        ref: (workspaceId: string) => ({
          agents: {
            create: async (request: (typeof created)[number]) => {
              created.push({ ...request, workspaceId });
              const agent = {
                id: request.agentId,
                provider: request.config.provider.split("/")[0],
                status: hooks.createdStatus ?? "idle",
                currentModeId: request.config.modeId,
                title: request.title,
                workspaceId: "ws-1",
                archivedAt: null,
                labels: request.labels,
              };
              agents.push(agent);
              byId.set(agent.id, agent);
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
        ref: (id: string) => ({
          refresh: async () => {
            hooks.onRefresh?.(id);
            return { agent: byId.get(id) ?? null };
          },
          send: async (text: string, options: { messageId?: string } = {}) => {
            if (hooks.send) return hooks.send(id, text, options.messageId);
            sends.push({ agentId: id, text, messageId: options.messageId });
            addTurn(id, { type: "user_message", text }, options.messageId);
          },
          timeline: {
            append: async (item: { type: "plugin"; id: string; kind: string; version: number; data: (typeof notes)[number] }) => {
              notes.push(item.data);
              addTurn(id, { ...item, pluginId: "zerosub" } as AgentTimelineItem);
            },
            refetch: async (options: { direction?: string; cursor?: { epoch: string; seq: number } | null; limit?: number } = {}) => {
              timelineReads.push({ id, direction: options.direction });
              hooks.onRefetch?.(id);
              if ((gap.source && id === AGENT) || (gap.fork && id !== AGENT)) {
                return { entries: [], gap: true, staleCursor: false, epoch: epochOf(id), window: { maxSeq: 0 }, hasOlder: false, startCursor: null };
              }
              const rows = timelines.get(id) ?? [];
              const limit = options.limit ?? 500;
              const older = options.direction === "before" && options.cursor ? rows.filter((row) => row.seqEnd < options.cursor!.seq) : rows;
              const page = older.slice(-limit);
              return {
                entries: page,
                gap: false,
                staleCursor: false,
                epoch: epochOf(id),
                window: { maxSeq: rows.reduce((max, row) => Math.max(max, row.seqEnd), 0) },
                hasOlder: older.length > page.length,
                startCursor: page.length ? { epoch: epochOf(id), seq: page[0]!.seqEnd } : null,
              };
            },
          },
        }),
      },
    };
    const service = new Service(
      {
        claude: claudeAdapter(() => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" })),
        codex: { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), family: "codex", portable: false } as FamilyAdapter,
      },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    );
    service.setPreferences(preferences.schema.parse({ forkOtherProvider: true, ...options.prefs }));
    const context = { paseo } as never;
    const limitTurn = () =>
      service.onTurnEnded(
        { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
        context,
      );
    return { service, store, created, notes, limitTurn, paseo: paseo as never, sends, timelines, addTurn, gap, byId, agents, hooks, setSourceEpoch: (epoch: string) => { sourceEpoch = epoch; }, timelineReads };
  }

  it("carries the work on with the other provider, at the same permission level", async () => {
    const { store, created, notes, limitTurn } = await setUpFork("bypassPermissions");
    await limitTurn();
    expect(created).toHaveLength(1);
    const fork = created[0];
    expect(fork?.config).toEqual({ provider: "codex/gpt-5.6-sol", modeId: "full-access" });
    expect(fork?.title).toBe("Fix the build (continued on ChatGPT)");
    expect(fork?.labels).toEqual({ "zerosub.continued-from": AGENT });
    expect(fork?.prompt).toMatch(/earlier Claude Code session that stopped because every Claude account reached its usage limit/);
    expect((await store.read()).bindings[fork?.agentId ?? ""]).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", toFamily: "codex", to: "hello", continuedIn: { agentId: fork?.agentId } });
  });

  it.each([
    ["its parent", [], "lead"],
    ["where its parent's own work went on ChatGPT", [{ id: "lead-on-chatgpt", provider: "codex", labels: { "zerosub.continued-from": "lead" } }], "lead-on-chatgpt"],
  ])("carries a sub-agent's work on as a sub-agent of %s", async (_, moved, parent) => {
    const lead = { id: "lead", provider: "claude", status: "idle", title: "Lead the release", workspaceId: "ws-1", archivedAt: null, labels: {} };
    const others = [lead, ...moved.map((agent) => ({ status: "idle", title: "Lead the release (continued on ChatGPT)", workspaceId: "ws-1", archivedAt: null, ...agent }))];
    const { created, limitTurn } = await setUpFork("bypassPermissions", [], { "paseo.parent-agent-id": "lead" }, others);
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(created[0]?.labels).toEqual({ "zerosub.continued-from": AGENT, "paseo.parent-agent-id": parent });
    expect(created[0]?.prompt).toMatch(/earlier Claude Code session that stopped because every Claude account reached its usage limit/);
  });

  it("points at the earlier fork instead of starting another", async () => {
    const { created, notes, limitTurn } = await setUpFork("bypassPermissions");
    await limitTurn();
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", continuedIn: { agentId: created[0]?.agentId } });
  });

  it("won't fork into a mode more permissive than the original's", async () => {
    const { created, notes, limitTurn } = await setUpFork("default");
    await limitTurn();
    expect(created).toHaveLength(0);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
    expect(notes.at(-1)?.detail).toMatch(/no mode as careful as this agent's \(“Always Ask”\)/);
  });

  it("hands the fork the whole conversation when the hook sends none", async () => {
    // Paseo 0.13 sends turn-ended hooks no timeline. The fork pages the conversation itself instead
    // of taking the rows the limit was read from, so it still gets the request from 48 rows back.
    const steps = Array.from({ length: 45 }, (_, step): AgentTimelineItem => ({ type: "assistant_message", text: `Step ${step + 1} done.` }));
    const conversation = [
      ...inTurn("t0", { type: "user_message", text: "Fix the build" }, ...steps),
      ...inTurn("t", { type: "user_message", text: "Now run the linter" }, { type: "assistant_message", text: "You've hit your session limit · resets 3pm (UTC)" }),
    ];
    const { created, limitTurn } = await setUpFork("bypassPermissions", conversation);
    await limitTurn();
    const prompt = created[0]?.prompt ?? "";
    expect(prompt.match(/User: Fix the build/g) ?? []).toHaveLength(1);
    expect(prompt).toContain("Step 45 done.");
    expect(prompt).toContain("User: Now run the linter");
  });

  describe("forking to OpenCode", () => {
      const PREFS = {
      forkOtherProvider: true,
      claudeForkDestination: "opencode",
      forkOpenCodeModel: "opencode/glm-5p3-flash",
      forkOpenCodeThinking: "high",
    };

    it("continues a stopped Claude chat on OpenCode with the saved model, thinking, and no account", async () => {
      const { store, created, notes, sends, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await limitTurn();
      expect(created).toHaveLength(1);
      const fork = created[0];
      expect(fork?.config).toEqual({
        provider: "opencode/opencode/glm-5p3-flash",
        modeId: "code", // no more permissive than Bypass
        thinkingOptionId: "high",
      });
      expect(fork?.title).toBe("Fix the build (continued on OpenCode)");
      expect(fork?.labels).toEqual({ "zerosub.continued-from": AGENT });
      expect(fork?.idempotencyKey).toBe(fork?.agentId);
      // The fork is created promptless; the handoff is delivered afterwards under a reserved ID.
      expect(created[0]?.prompt).toBeUndefined();
      expect(sends).toHaveLength(1);
      expect(sends[0]?.agentId).toBe(fork?.agentId);
      expect(sends[0]?.text).toMatch(/earlier Claude Code session that stopped because every Claude account reached its usage limit/);
      expect(sends[0]?.messageId).toMatch(/^zerosub-handoff-/);
      expect(sends[0]?.text).toContain(`zerosub transfer ${sends[0]?.messageId}`);
      // OpenCode is a harness, not an account provider: no binding, so no account store entry.
      expect((await store.read()).bindings[fork?.agentId ?? ""]).toBeUndefined();
      expect(notes.at(-1)).toMatchObject({
        outcome: "continued",
        to: "OpenCode",
        toFamily: null,
        toProvider: "opencode",
        continuedIn: { agentId: fork?.agentId },
      });
    });

    it("uses the host's default model, and no thinking override, when none was saved", async () => {
      const { created, limitTurn } = await setUpFork("default", [], {}, [], {
        prefs: { forkOtherProvider: true, claudeForkDestination: "opencode" },
        opencodeModes: [{ id: "ask", label: "Ask", colorTier: "safe" }],
      });
      await limitTurn();
      expect(created[0]?.config).toEqual({ provider: "opencode/opencode/glm-5p3-flash", modeId: "ask" });
    });

    it("points at the earlier OpenCode fork instead of starting another", async () => {
      const { created, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await limitTurn();
      await limitTurn();
      expect(created).toHaveLength(1);
    });

    const RESERVED = { targetId: "fork-reserved", messageId: "zerosub-handoff-reserved" };
    const MARK = { epoch: "epoch-1", seq: 0 };
    const opencodeAgent = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      provider: "opencode",
      status: "idle",
      title: "Fix the build (continued on OpenCode)",
      currentModeId: "code",
      workspaceId: "ws-1",
      archivedAt: null,
      labels: { "zerosub.continued-from": AGENT },
      ...overrides,
    });
    const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
    const whyOf = (source: "auto" | "user") => (source === "auto" ? "every Claude account reached its usage limit" : "the work was moved to OpenCode");
    const CREATE_CONFIG = {
      provider: "opencode/opencode/glm-5p3-flash",
      modeId: "code",
      thinkingOptionId: "high",
      workspaceId: "ws-1",
      cwd: null,
      parentId: null,
      title: "Fix the build (continued on OpenCode)",
      why: whyOf("user"),
    };
    const initialDigest = (source: "auto" | "user" = "user") =>
      digestOf([continuationPrompt(buildTranscript([]), whyOf(source), "Claude Code"), `zerosub transfer ${RESERVED.messageId}`].join("\n"));
    /** A harness with an existing, settled fork record and its live target agent. */
    const setUpReuse = async (fork: Record<string, unknown> = {}, record: Omit<OpenCodeFork, "forkAgentId"> = {}) => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = { forkAgentId: RESERVED.targetId, ...record };
      });
      setup.byId.set(RESERVED.targetId, opencodeAgent(RESERVED.targetId, fork));
      return setup;
    };
    const seededPending = (pending: NonNullable<OpenCodeFork["pending"]>): OpenCodeFork => ({
      forkAgentId: RESERVED.targetId,
      pending,
    });
    const reservedCreation = (source: "auto" | "user" = "user", sentDigest = initialDigest(source)): OpenCodeFork =>
      seededPending({
        stage: "creating",
        targetId: RESERVED.targetId,
        messageId: RESERVED.messageId,
        seen: MARK,
        config: { ...CREATE_CONFIG, why: whyOf(source) },
        sentDigest,
      });

    it("sends new instructions to the existing fork exactly once, then nothing new on a third fork", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.limitTurn();
      expect(setup.created).toHaveLength(1);
      const forkId = setup.created[0]!.agentId;
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await setup.limitTurn();
      expect(setup.created).toHaveLength(1);
      const updates = setup.sends.filter((send) => send.text.includes("Now also update the CHANGELOG"));
      expect(updates).toHaveLength(1);
      expect(updates[0]!.agentId).toBe(forkId);
      expect(updates[0]!.messageId).toMatch(/^zerosub-handoff-/);
      expect(updates[0]!.text).toContain(`zerosub transfer ${updates[0]!.messageId}`);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "continued", continuedIn: { agentId: forkId } });
      // Nothing new on the source: nothing is sent, and the row says so instead of claiming a handoff.
      await setup.limitTurn();
      expect(setup.sends).toHaveLength(2);
      expect(setup.notes.at(-1)).toMatchObject({
        outcome: "stayed",
        detail: "No update was sent: the OpenCode continuation already has everything from this agent.",
        continuedIn: { agentId: forkId },
      });
    });

    /** A settled fork whose source gained only a plugin note, with `act` run once as its watermark is saved. */
    const duringWatermarkWrite = async (act: (setup: Awaited<ReturnType<typeof setUpFork>>) => void) => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "plugin", id: "external-note", pluginId: "synthetic", kind: "note", version: 1, data: {} });
      const inspected = setup.timelines.get(AGENT)!.at(-1)!.seqEnd;
      const save = setup.store.update.bind(setup.store);
      let done = false;
      setup.store.update = async (change) => {
        const next = await save(change);
        if (!done && next.opencodeForks[AGENT]?.seen?.seq === inspected) {
          done = true;
          act(setup);
        }
        return next;
      };
      return { setup, inspected };
    };

    it("reports an instruction that arrives while an empty update's watermark is saved, then sends it once", async () => {
      const { setup, inspected } = await duringWatermarkWrite((setup) =>
        setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2"));
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual({ epoch: "epoch-1", seq: inspected });
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("Now also update the CHANGELOG");
      expect(setup.created).toHaveLength(0);
    });

    it("reports an instruction that lands between the history recheck and the final refresh", async () => {
      const { setup, inspected } = await duringWatermarkWrite((setup) => {
        // The history recheck has nothing new; the instruction lands just before the last source refresh.
        let reads = 0;
        setup.hooks.onRefetch = (id) => {
          if (id !== AGENT || ++reads !== 1) return;
          setup.hooks.onRefresh = (refreshed) => {
            if (refreshed !== AGENT) return;
            setup.hooks.onRefresh = undefined;
            setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
            setup.byId.get(AGENT)!.lastUserMessageAt = "2026-09-23T07:30:00.000Z";
          };
        };
      });
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen?.seq).toBe(inspected);
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("Now also update the CHANGELOG");
    });

    it("refuses up-to-date when the source starts working while the watermark is saved", async () => {
      const { setup, inspected } = await duringWatermarkWrite((setup) => { setup.byId.get(AGENT)!.status = "running"; });
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/working or waiting for permission/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen?.seq).toBe(inspected);
    });

    it.each([
      ["a history gap", "gap", /couldn't read this agent's handoff history/],
      ["an epoch reset", "epoch", /couldn't tell what it has already received/],
    ])("calls %s while the watermark is saved an inspection, not up-to-date", async (_, kind, detail) => {
      const { setup, inspected } = await duringWatermarkWrite((setup) => {
        if (kind === "gap") setup.gap.source = true;
        else setup.setSourceEpoch("epoch-2");
      });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("found");
      expect(setup.notes.at(-1)?.detail).toMatch(detail);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen?.seq).toBe(inspected);
    });

    it("never sends to a recorded fork that names a different source", async () => {
      const setup = await setUpReuse({ labels: { "zerosub.continued-from": "different-source" } }, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.sends).toHaveLength(0);
    });

    it("advances past plugin-only notes without sending an empty update or feeding a repeat", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, {
        type: "plugin",
        id: "external-note",
        pluginId: "synthetic",
        kind: "note",
        version: 1,
        data: {},
      });
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("up-to-date");
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("up-to-date");
      expect(setup.sends).toHaveLength(0);
      expect(setup.timelines.get(AGENT)).toHaveLength(3);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual({
        epoch: "epoch-1",
        seq: setup.timelines.get(AGENT)!.at(-2)!.seqEnd,
      });
      expect(setup.notes).toHaveLength(2);
      expect(setup.notes.every((note) => note.delivery === "up-to-date")).toBe(true);
    });

    it("returns an inspection result instead of replaying history after a source epoch reset", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "OLD already sent" });
      setup.setSourceEpoch("epoch-2");
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("found");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", delivery: "found" });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't tell what it has already received/);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual(MARK);
    });

    it("retries a lost create acknowledgement with the same target, idempotency key, and message ID", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation();
      });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.agentId).toBe(RESERVED.targetId);
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]).toMatchObject({
        agentId: RESERVED.targetId,
        idempotencyKey: RESERVED.targetId,
        title: CREATE_CONFIG.title,
        config: { provider: CREATE_CONFIG.provider, modeId: CREATE_CONFIG.modeId, thinkingOptionId: CREATE_CONFIG.thinkingOptionId },
        labels: { "zerosub.continued-from": AGENT },
      });
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).toBe(RESERVED.messageId);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    const damage = {
      "the registry is not JSON": "{ not json",
      "the source's record doesn't validate": JSON.stringify({ accounts: [], opencodeForks: { [AGENT]: { forkAgentId: 7 } } }),
    };
    const targets = {
      "absent": [] as Array<Record<string, unknown>>,
      "archived": [opencodeAgent(RESERVED.targetId, { archivedAt: "2026-09-23T08:00:00.000Z" })],
    };
    describe.each(Object.entries(damage))("after a restart where %s", (_, broken) => {
      /** A reservation is unconfirmed when the registry breaks; the restarted service can't see it. */
      const restart = async (target: Array<Record<string, unknown>>) => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await setUpReuse(
          {},
          seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf("unconfirmed") }),
        );
        await writeFile(join(root, "state.json"), broken);
        return setUpFork("bypassPermissions", [], {}, target, { prefs: PREFS });
      };

      it.each(Object.entries(targets))("never forks again on its own when the reserved target is %s", async (_, target) => {
        const second = await restart(target);
        await second.limitTurn();
        expect(second.created).toHaveLength(0);
        expect(second.sends).toHaveLength(0);
        expect(second.notes.at(-1)).toMatchObject({ outcome: "stayed" });
        expect(second.notes.at(-1)?.detail).toMatch(/record of what it sent to OpenCode/);
      });

      it.each(Object.entries(targets))("asks before a manual fork when the reserved target is %s, then starts one", async (_, target) => {
        const second = await restart(target);
        await expect(second.service.forkAgent(second.paseo, AGENT, "opencode")).rejects.toThrow(/choose Continue on OpenCode again/);
        expect(second.created).toHaveLength(0);
        expect(second.sends).toHaveLength(0);
        await second.service.forkAgent(second.paseo, AGENT, "opencode");
        expect(second.created).toHaveLength(1);
        expect(second.sends).toHaveLength(1);
      });
    });

    /** Runs `change` when `continueInNewAgent` itself refreshes the source, after every earlier check. */
    const atHelperRefresh = (setup: Awaited<ReturnType<typeof setUpFork>>, change: (source: Record<string, unknown>) => void) => {
      setup.hooks.onRefresh = (id) => {
        if (id === AGENT && new Error().stack?.includes("continueInNewAgent")) change(setup.byId.get(AGENT)!);
      };
    };

    it("repeats a reserved create with its frozen title even when the source is renamed at the create", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => { draft.opencodeForks[AGENT] = reservedCreation(); });
      atHelperRefresh(setup, (source) => { source.title = "Other task"; });
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode").catch(() => undefined);
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]).toMatchObject({
        agentId: RESERVED.targetId,
        idempotencyKey: RESERVED.targetId,
        workspaceId: CREATE_CONFIG.workspaceId,
        title: CREATE_CONFIG.title,
        config: { provider: CREATE_CONFIG.provider, modeId: CREATE_CONFIG.modeId, thinkingOptionId: CREATE_CONFIG.thinkingOptionId },
      });
    });

    it("refuses a reserved create when the source moves workspace at the create, instead of changing it", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => { draft.opencodeForks[AGENT] = reservedCreation(); });
      atHelperRefresh(setup, (source) => { source.workspaceId = "ws-2"; });
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.created).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
    });

    it.each([
      ["a history gap before the write", 2, "gap"],
      ["a history gap after the write", 3, "gap"],
      ["an epoch reset before the write", 2, "epoch"],
      ["an epoch reset after the write", 3, "epoch"],
    ])("calls %s on an update an inspection, not a newer message", async (_, read, kind) => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      let reads = 0;
      setup.hooks.onRefetch = (id) => {
        if (id !== AGENT || ++reads !== read) return;
        if (kind === "gap") setup.gap.source = true;
        else setup.setSourceEpoch("epoch-2");
      };
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("found");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)?.detail).not.toMatch(/newer message/);
      expect(setup.notes.at(-1)?.detail).toMatch(kind === "gap" ? /couldn't read this agent's handoff history/ : /couldn't tell what it has already received/);
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.seen).toEqual(MARK);
      expect(record.pending).toBeUndefined();
    });

    it.each([
      ["before the write", 3],
      ["after the write", 4],
    ])("keeps a creation reserved and uncertain on a history gap %s", async (_, read) => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      let reads = 0;
      setup.hooks.onRefetch = (id) => {
        if (id === AGENT && ++reads === read) setup.gap.source = true;
      };
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed" });
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
    });

    /** Rewrites the registry file as a restart would find it. */
    const editRegistry = async (edit: (raw: Record<string, Record<string, unknown>>) => void) => {
      const raw = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
      edit(raw);
      await writeFile(join(root, "state.json"), JSON.stringify(raw));
    };

    it("keeps holding a source when its hold is corrupted before a second restart", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await setUpReuse({}, seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: "d" }));
      await writeFile(join(root, "state.json"), "{ not json");
      await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS }); // the first restart records the hold
      await editRegistry((raw) => { raw.opencodeHolds = { [AGENT]: { at: 7 } }; });
      const third = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await third.limitTurn();
      expect(third.created).toHaveLength(0);
      expect(third.sends).toHaveLength(0);
      expect(third.notes.at(-1)?.detail).toMatch(/record of what it sent to OpenCode/);
    });

    it("asks again after a second loss, even though the first one was acknowledged", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await setUpReuse({}, seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: "d" }));
      await editRegistry((raw) => { raw.opencodeForks = { [AGENT]: { forkAgentId: 7 } }; });
      const first = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await expect(first.service.forkAgent(first.paseo, AGENT, "opencode")).rejects.toThrow(/choose Continue on OpenCode again/);
      await first.service.forkAgent(first.paseo, AGENT, "opencode");
      expect(first.created).toHaveLength(1);
      // The new record is lost too: that is a new event the first acknowledgement doesn't cover.
      await editRegistry((raw) => { raw.opencodeForks = { [AGENT]: { forkAgentId: 7 } }; });
      const second = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await expect(second.service.forkAgent(second.paseo, AGENT, "opencode")).rejects.toThrow(/choose Continue on OpenCode again/);
      expect(second.created).toHaveLength(0);
      expect(second.sends).toHaveLength(0);
    });

    it.each(Object.entries(targets))("never replaces a fork whose record has no checkpoint when the target is %s", async (_, target) => {
      const setup = await setUpFork("bypassPermissions", [], {}, target, { prefs: PREFS });
      await setup.store.update((draft) => { draft.opencodeForks[AGENT] = { forkAgentId: RESERVED.targetId }; });
      await setup.limitTurn();
      expect(setup.created).toHaveLength(0);
      expect(setup.sends).toHaveLength(0);
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/choose Continue on OpenCode again/);
      expect(setup.created).toHaveLength(0);
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.created).toHaveLength(1);
    });

    it("refuses an update when the source's parent changes while the mode catalog is read", async () => {
      const parents = ["parent-a", "parent-b"].map((id) => ({ id, provider: "claude", status: "idle", workspaceId: "ws-1", archivedAt: null, labels: {} }));
      const setup = await setUpFork("bypassPermissions", [], { "paseo.parent-agent-id": "parent-a" }, parents, { prefs: PREFS });
      await setup.store.update((draft) => { draft.opencodeForks[AGENT] = { forkAgentId: RESERVED.targetId, seen: MARK }; });
      setup.byId.set(RESERVED.targetId, opencodeAgent(RESERVED.targetId, { labels: { "zerosub.continued-from": AGENT, "paseo.parent-agent-id": "parent-a" } }));
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      // Calls 1-4 are the earlier checks; call 5 is the catalog read inside the check right before the send.
      let reads = 0;
      setup.hooks.onModes = () => {
        if (++reads === 5) (setup.byId.get(AGENT)!.labels as Record<string, string>)["paseo.parent-agent-id"] = "parent-b";
      };
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.sends).toHaveLength(0);
    });

    it("refuses a reserved creation when the source and fork move together while modes are read", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      // Calls 1-4 are the create's own and the check before the write; call 5 is inside the check
      // right before the send, after that check has already compared the source with its record.
      let reads = 0;
      setup.hooks.onModes = () => {
        if (++reads === 5) for (const agent of setup.byId.values()) agent.workspaceId = "ws-2";
      };
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
    });

    it("re-reads the persisted reservation after a restart-shaped rebuild of the service", async () => {
      const first = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await first.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation();
      });
      // A second service over the same state file: what a worker restart re-reads.
      const second = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      const done = await second.service.forkAgent(second.paseo, AGENT, "opencode");
      expect(done.agentId).toBe(RESERVED.targetId);
      expect(first.created).toHaveLength(0);
      expect(second.created).toHaveLength(1);
      expect(second.created[0]!.agentId).toBe(RESERVED.targetId);
    });

    it.each([
      ["moved workspace", { workspaceId: "ws-2" }],
      ["busy target", { status: "running" }],
      ["pending permission", { pendingPermissions: [{ id: "p1" }] }],
      ["changed parent", { labels: { "zerosub.continued-from": AGENT, "paseo.parent-agent-id": "elsewhere" } }],
      ["changed provider", { provider: "claude" }],
    ])("keeps a resumed creation reserved when its target has a %s", async (_, overrides) => {
      const setup = await setUpReuse(overrides, reservedCreation());
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect(setup.created).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", delivery: "uncertain" });
    });

    it("refuses a resumed creation whose rebuilt prompt differs from its frozen digest", async () => {
      const setup = await setUpReuse({}, reservedCreation("user", digestOf("a different reserved prompt")));
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.sentDigest).toBe(digestOf("a different reserved prompt"));
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", delivery: "uncertain" });
    });

    it("rebuilds an automatic fork with its reserved reason when a manual retry delivers it", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation("auto");
      });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.agentId).toBe(RESERVED.targetId);
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).toBe(RESERVED.messageId);
      expect(setup.sends[0]!.text).toContain("every Claude account reached its usage limit");
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("keeps a manually reserved reason when the retry is automatic", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation("user");
      });
      await setup.limitTurn();
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("the work was moved to OpenCode");
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("keeps a legacy reservation without a saved reason uncertain instead of guessing the trigger", async () => {
      const setup = await setUpReuse({}, reservedCreation("auto"));
      await setup.store.update((draft) => {
        const config = draft.opencodeForks[AGENT]!.pending!.config!;
        delete config.why;
      });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.created).toHaveLength(0);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
    });

    it("names the reserved fork by its known ID when it has no title to show", async () => {
      const setup = await setUpReuse({ title: null }, reservedCreation("user", digestOf("a different reserved prompt")));
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(done.title).toBe(`OpenCode agent ${RESERVED.targetId}`);
      expect(setup.notes.at(-1)?.continuedIn).toEqual({ agentId: RESERVED.targetId, title: `OpenCode agent ${RESERVED.targetId}` });
    });

    it("finds a receipt older than the last 500 rows without sending again", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // The receipt sits at row 1, behind 500 newer rows: one tail page misses it.
      const rows = [
        { item: { type: "user_message", text: sent } as AgentTimelineItem, seqEnd: 1 },
        ...Array.from({ length: 500 }, (_, row) => ({ item: { type: "assistant_message", text: `Row ${row}` } as AgentTimelineItem, seqEnd: row + 2 })),
      ];
      setup.timelines.set(RESERVED.targetId, rows);
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.pending).toBeUndefined();
      expect(setup.sends.filter((send) => send.agentId === RESERVED.targetId)).toHaveLength(0);
      expect(setup.timelineReads.filter((read) => read.id === RESERVED.targetId)).toHaveLength(2);
    });

    it("stops a receipt scan at its page budget and stays uncertain", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // More non-matching rows than any budget: the scan can't finish, so nothing is claimed.
      setup.timelines.set(
        RESERVED.targetId,
        Array.from({ length: 5_500 }, (_, row) => ({ item: { type: "assistant_message", text: `Row ${row}` } as AgentTimelineItem, seqEnd: row + 1 })),
      );
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.messageId).toBe("zerosub-handoff-m1");
      expect(setup.timelineReads.filter((read) => read.id === RESERVED.targetId).length).toBeLessThanOrEqual(10);
    });

    it("stays uncertain when the fork's history has a gap instead of calling it undelivered", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      setup.gap.fork = true;
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.messageId).toBe("zerosub-handoff-m1");
    });

    it("settles a pending send by marker and digest when a reload dropped the message ID", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // A provider reload changed the epoch and dropped clientMessageId and turnId from the row.
      setup.timelines.set(RESERVED.targetId, [{ item: { type: "user_message", text: sent }, seqEnd: 1 }]);
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.pending).toBeUndefined();
      // The settled reservation's mark, then the update's mark on top of it.
      expect(record.seen).toEqual({ epoch: "epoch-1", seq: 2 });
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("Now also update the CHANGELOG");
    });

    it("reconciles a first-page receipt with a single read of the fork's timeline", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      setup.timelines.set(RESERVED.targetId, [{ item: { type: "user_message", text: sent }, seqEnd: 1 }]);
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("up-to-date");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
      expect(setup.timelineReads.filter((read) => read.id === RESERVED.targetId)).toHaveLength(1);
    });

    it("keeps an unconfirmed send reserved and reports uncertainty instead of resending", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // The fork's timeline holds no marker: no trustworthy receipt either way.
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.messageId).toBe("zerosub-handoff-m1");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", continuedIn: { agentId: RESERVED.targetId } });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't be confirmed \(transfer zerosub-handoff-m1\)/);
    });

    it("keeps the pending reservation when the target is archived, instead of starting another fork", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        { archivedAt: "2026-09-23T08:00:00.000Z" },
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.created).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.messageId).toBe("zerosub-handoff-m1");
    });

    it("reuses the same message ID when an update's acknowledgement was lost", async () => {
      const sent = "The update text.\nzerosub transfer zerosub-handoff-u1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-u1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // The send arrived; the service stopped before it could record the receipt.
      setup.timelines.set(RESERVED.targetId, [
        { item: { type: "user_message", text: sent, clientMessageId: "zerosub-handoff-u1" }, turnId: "turn-x", seqEnd: 1 },
      ]);
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(0); // reconciled, not resent
      const rows = setup.timelines.get(RESERVED.targetId)!;
      expect(rows.filter((row) => row.item.type === "user_message" && row.item.clientMessageId === "zerosub-handoff-u1")).toHaveLength(1);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("replaces a settled fork that was archived later", async () => {
      const setup = await setUpReuse({ archivedAt: "2026-09-23T08:00:00.000Z" }, { seen: MARK });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.agentId).not.toBe(RESERVED.targetId);
      expect(setup.created).toHaveLength(1);
      expect((await setup.store.read()).opencodeForks[AGENT]!.forkAgentId).toBe(done.agentId);
    });

    it("transfers an imported handoff as instructions, filtering only its own message IDs", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.limitTurn();
      setup.addTurn(
        AGENT,
        { type: "user_message", text: "This task is continuing from an earlier session that stopped because it hit its limit." },
        "user-2",
      );
      setup.addTurn(AGENT, { type: "user_message", text: "Old reserved copy" }, "zerosub-handoff-old");
      await setup.limitTurn();
      const update = setup.sends.at(-1)!;
      expect(update.text).toContain("This task is continuing from an earlier session");
      expect(update.text).not.toContain("Old reserved copy");
    });

    it("reports found for an earlier fork without a state record and sends nothing", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [opencodeAgent("fork-old")], { prefs: PREFS });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done).toMatchObject({ agentId: "fork-old", delivery: "found" });
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", continuedIn: { agentId: "fork-old" } });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't tell what it has already received/);
    });

    it("refuses to send into a fork that moved, is working, changed parent, or waits for permission", async () => {
      const refused = async (overrides: Record<string, unknown>) => {
        const setup = await setUpReuse(overrides, { seen: MARK });
        await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved, is working or is waiting for permission/);
        expect(setup.sends).toHaveLength(0);
      };
      await refused({ workspaceId: "ws-2" });
      await refused({ status: "running" });
      await refused({ labels: { "zerosub.continued-from": AGENT, "paseo.parent-agent-id": "elsewhere" } });
      await refused({ pendingPermissions: [{ id: "p1" }] });
    });

    it("refuses honestly when the source's handoff history has a gap", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.gap.source = true;
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", continuedIn: { agentId: RESERVED.targetId } });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't read this agent's handoff history/);
    });

    it("refuses to keep sending to an older fork once the source moved to a more careful mode", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.byId.get(AGENT)!.currentModeId = "plan";
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/mode changed/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual(MARK);
    });

    it.each([
      ["a broader mode than the source's", "code", "acceptEdits"],
      ["a mode the catalog doesn't list", "mystery", "bypassPermissions"],
    ])("refuses a fork now in %s", async (_, forkMode, sourceMode) => {
      const setup = await setUpReuse({ currentModeId: forkMode }, { seen: MARK });
      setup.byId.get(AGENT)!.currentModeId = sourceMode;
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/mode changed/);
      expect(setup.sends).toHaveLength(0);
    });

    it("still sends to a fork in a more careful mode than the source's", async () => {
      const setup = await setUpReuse({ currentModeId: "build" }, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
    });

    it("refuses an update when the source gained a newer instruction after it was read", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      let sourceReads = 0;
      setup.hooks.onRefetch = (id) => {
        if (id === AGENT && ++sourceReads === 2) setup.addTurn(AGENT, { type: "user_message", text: "STOP" }, "user-3");
      };
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual(MARK);
    });

    it("rebuilds an undelivered reserved creation with the source's newer instruction", async () => {
      const setup = await setUpReuse({}, reservedCreation());
      setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-2");
      const stopSeq = setup.timelines.get(AGENT)!.at(-1)!.seqEnd;
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).toBe(RESERVED.messageId);
      expect(setup.sends[0]!.text).toContain("STOP, DO NOT MODIFY ANYTHING");
      // The rebuilt reservation's mark covers the STOP, not the row ZeroSub appended afterwards.
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen?.seq).toBe(stopSeq);
    });

    /** Runs `act` once, right after the store commits a sending reservation. */
    const duringSendingWrite = (setup: Awaited<ReturnType<typeof setUpFork>>, act: () => void) => {
      const save = setup.store.update.bind(setup.store);
      let done = false;
      setup.store.update = async (change) => {
        const next = await save(change);
        if (!done && next.opencodeForks[AGENT]?.pending?.stage === "sending") {
          done = true;
          act();
        }
        return next;
      };
    };

    it("releases an update reservation when a STOP lands while it is being written", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      duringSendingWrite(setup, () => setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-3"));
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.pending).toBeUndefined();
      expect(record.seen).toEqual(MARK);
      // Nothing was dispatched, so the next call carries both instructions in one send.
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("STOP, DO NOT MODIFY ANYTHING");
    });

    it("returns a creation to its reserved state when a STOP lands while it is being written", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      duringSendingWrite(setup, () => setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-2"));
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      const pending = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      expect(pending.stage).toBe("creating");
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).toBe(pending.messageId);
      expect(setup.sends[0]!.text).toContain("STOP, DO NOT MODIFY ANYTHING");
    });

    it.each([
      ["the freshness read", 2],
      ["the read after the reservation is written", 3],
    ])("refuses when the source moves to Plan during %s", async (_, read) => {
      const setup = await setUpReuse({ currentModeId: "build" }, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      let reads = 0;
      setup.hooks.onRefetch = (id) => {
        if (id === AGENT && ++reads === read) setup.byId.get(AGENT)!.currentModeId = "plan";
      };
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/mode changed/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("never sends a reservation whose original prompt doesn't match its digest, even with newer input", async () => {
      const setup = await setUpReuse({}, reservedCreation("user", digestOf("a different reserved prompt")));
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.sentDigest).toBe(digestOf("a different reserved prompt"));
    });

    it("waits for an automatic source that reports idle just after its turn ended", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS, sourceStatus: "running" });
      setTimeout(() => { setup.byId.get(AGENT)!.status = "idle"; }, 500);
      await setup.limitTurn();
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
    });

    it("keeps an oversized todo inside the update's bounds with the latest STOP last", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "todo", items: [{ text: "t".repeat(200_000), completed: false }] });
      setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-2");
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      const text = setup.sends[0]!.text;
      expect(text.length).toBeLessThan(42_000);
      expect(text).toContain("[… omitted …]");
      expect(text.indexOf("Task list at the time it stopped:")).toBeLessThan(text.indexOf("STOP, DO NOT MODIFY ANYTHING"));
    });

    it("never sends the older initial request when a STOP lands after it was gathered", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.addTurn(AGENT, { type: "user_message", text: "Fix the build" }, "user-1");
      // The STOP arrives after the create gathered the window it reserved, before the delivery.
      let added = false;
      setup.hooks.onRefetch = (id) => {
        if (id === AGENT && setup.created.length === 1 && !added) {
          added = true;
          setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-2");
        }
      };
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("STOP, DO NOT MODIFY ANYTHING");
    });

    it("waits for a created fork that is still initializing, then delivers once", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.hooks.createdStatus = "initializing";
      // The fork reports idle a moment after it is created, as a promptless OpenCode agent does.
      const settle = setInterval(() => {
        for (const agent of setup.byId.values()) if (agent.status === "initializing") setTimeout(() => { agent.status = "idle"; }, 500);
      }, 100);
      try {
        expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      } finally {
        clearInterval(settle);
      }
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
    });

    it("keeps the reservation when a created fork never finishes initializing", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.hooks.createdStatus = "initializing";
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
    }, 15_000);

    it("settles a send whose acknowledgement was lost when the receipt is there", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      setup.hooks.send = (id, text, messageId) => {
        setup.sends.push({ agentId: id, text, messageId });
        setup.addTurn(id, { type: "user_message", text }, messageId);
        throw new Error("socket hang up");
      };
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("stays uncertain, keeping the transfer, when the send and the receipt read both throw", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      setup.hooks.send = (id, text, messageId) => {
        setup.sends.push({ agentId: id, text, messageId });
        setup.hooks.onRefetch = (read) => {
          if (read === RESERVED.targetId) throw new Error("timeline read failed");
        };
        throw new Error("socket hang up");
      };
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(done.agentId).toBe(RESERVED.targetId);
      const pending = (await setup.store.read()).opencodeForks[AGENT]!.pending;
      expect(pending?.messageId).toBe(setup.sends[0]!.messageId);
      expect(setup.notes.at(-1)?.detail).toContain(setup.sends[0]!.messageId!);
      expect(setup.sends).toHaveLength(1);
    });

    it("puts the latest instruction after older progress and todos in an update", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "CONTINUE EVERYTHING" }, "user-2");
      setup.addTurn(AGENT, { type: "assistant_message", text: "Continuing with the release." });
      setup.addTurn(AGENT, { type: "todo", items: [{ text: "Ship it", completed: false }] });
      setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-3");
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      const text = setup.sends[0]!.text;
      expect(text.indexOf("Continuing with the release.")).toBeLessThan(text.indexOf("STOP, DO NOT MODIFY ANYTHING"));
      expect(text.indexOf("- [ ] Ship it")).toBeLessThan(text.indexOf("STOP, DO NOT MODIFY ANYTHING"));
      expect(text.indexOf("CONTINUE EVERYTHING")).toBeLessThan(text.indexOf("STOP, DO NOT MODIFY ANYTHING"));
    });

    it("keeps the update's watermark when older history has no usable cursor", async () => {
      const setup = await setUpReuse({}, { seen: { epoch: "epoch-1", seq: 1 } });
      setup.timelines.set(
        AGENT,
        Array.from({ length: 600 }, (_, row) => ({ item: { type: "assistant_message", text: `Row ${row}` } as AgentTimelineItem, seqEnd: row + 1 })),
      );
      const timeline = setup.paseo as unknown as { agents: { ref: (id: string) => { timeline: { refetch: (o: unknown) => Promise<Record<string, unknown>> } } } };
      const ref = timeline.agents.ref;
      timeline.agents.ref = (id: string) => {
        const real = ref(id);
        if (id !== AGENT) return real;
        const refetch = real.timeline.refetch;
        real.timeline.refetch = async (options: unknown) => ({ ...(await refetch(options)), startCursor: null });
        return real;
      };
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual({ epoch: "epoch-1", seq: 1 });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't read this agent's handoff history/);
    });

    const refusalCases: Array<{
      name: string;
      options: { prefs?: Record<string, unknown>; opencodeAvailable?: boolean; catalog?: Array<Record<string, unknown>> };
      refusal: RegExp;
    }> = [
      {
        name: "the saved model has left the catalog",
        options: { catalog: [{ id: "opencode/other", label: "Other", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] }] },
        refusal: /saved OpenCode model is no longer in this host's catalog/,
      },
      {
        name: "the saved thinking option is gone from the model",
        options: { catalog: [{ id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", isDefault: true, thinkingOptions: [{ id: "low", label: "Low" }] }] },
        refusal: /GLM 5.3 Flash” no longer offers the saved thinking option/,
      },
      { name: "the host reports no OpenCode", options: { opencodeAvailable: false }, refusal: /OpenCode isn't available in Paseo on this host/ },
      {
        name: "no model is marked default and none was saved",
        options: {
          catalog: [{ id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", thinkingOptions: [{ id: "high", label: "High" }] }],
          prefs: { forkOpenCodeModel: "" },
        },
        refusal: /No OpenCode model is marked default on this host/,
      },
    ];
    it.each(refusalCases)("refuses the fork when $name", async ({ options, refusal }) => {
      const { created, notes, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], {
        ...options,
        prefs: { ...PREFS, ...options.prefs },
      });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)).toMatchObject({ outcome: "stayed", toProvider: null, continuedIn: null });
      expect(notes.at(-1)?.detail).toMatch(refusal);
    });

    it("refuses the fork when OpenCode has no mode as careful as the original's", async () => {
      const { created, notes, limitTurn } = await setUpFork("default", [], {}, [], {
        prefs: PREFS,
        opencodeModes: [{ id: "yolo", label: "Yolo", colorTier: "dangerous" }],
      });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
      expect(notes.at(-1)?.detail).toMatch(/no mode as careful as this agent's \(“Always Ask”\)/);
  });

    it("never picks an OpenCode mode without a permission tier", async () => {
      // Paseo's own factory modes have no colorTier: they aren't permission tiers, so never chosen.
      const { created, notes, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], {
        prefs: PREFS,
        opencodeModes: [{ id: "bypass", label: "Bypass" }],
      });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
      expect(notes.at(-1)?.detail).toMatch(/no mode as careful as this agent's \(“Bypass”\)/);
  });
  });

  describe("manual OpenCode continuation", () => {
    const PREFS = { autoSwitch: false, forkOtherProvider: false, forkOpenCodeModel: "opencode/glm-5p3-flash", forkOpenCodeThinking: "high" };
    const manually = async (options: { modeId?: string } & Parameters<typeof setUpFork>[4] = {}) => {
      const { modeId = "bypassPermissions", ...rest } = options;
      const setup = await setUpFork(modeId, [], {}, [], rest);
      return { ...setup, fork: () => setup.service.forkAgent(setup.paseo, AGENT, "opencode") };
    };

    it("continues a stopped Claude chat on OpenCode with every toggle off and no ChatGPT accounts", async () => {
      const { store, created, notes, sends, fork } = await manually({ prefs: PREFS, noChatGPT: true });
      const done = await fork();
      expect(created).toHaveLength(1);
      expect(done).toEqual({ agentId: created[0]?.agentId, title: "Fix the build (continued on OpenCode)", delivery: "sent" });
      expect(created[0]?.config).toEqual({
        provider: "opencode/opencode/glm-5p3-flash",
        modeId: "code", // no more permissive than Bypass
        thinkingOptionId: "high",
      });
      expect(created[0]?.title).toBe("Fix the build (continued on OpenCode)");
      expect(sends[0]?.text).toMatch(/stopped because the work was moved to OpenCode/);
      // OpenCode is a harness, not an account provider: no binding, so no account store entry.
      expect((await store.read()).bindings[done.agentId]).toBeUndefined();
      expect(notes.at(-1)).toMatchObject({
        reason: "manual",
        continued: true,
        to: "OpenCode",
        toFamily: null,
        toProvider: "opencode",
        continuedIn: { agentId: done.agentId },
      });
    });

    it("points a second manual call at the earlier OpenCode fork instead of starting another", async () => {
      const { created, fork } = await manually({ prefs: PREFS });
      const first = await fork();
      const second = await fork();
      expect(created).toHaveLength(1);
      expect(second.agentId).toBe(first.agentId);
    });

    it("refuses when the saved model has left the catalog", async () => {
      const { created, fork } = await manually({
        prefs: PREFS,
        catalog: [{ id: "opencode/other", label: "Other", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] }],
      });
      await expect(fork()).rejects.toThrow(/saved OpenCode model is no longer in this host's catalog/);
      expect(created).toHaveLength(0);
    });

    it("refuses when the saved thinking option is gone from the model", async () => {
      const { created, fork } = await manually({
        prefs: PREFS,
        catalog: [{ id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", isDefault: true, thinkingOptions: [{ id: "low", label: "Low" }] }],
      });
      await expect(fork()).rejects.toThrow(/GLM 5.3 Flash” no longer offers the saved thinking option/);
      expect(created).toHaveLength(0);
    });

    it("refuses when OpenCode has no mode as careful as the original's", async () => {
      const { created, fork } = await manually({ prefs: PREFS, opencodeModes: [{ id: "yolo", label: "Yolo", colorTier: "dangerous" }], modeId: "default" });
      await expect(fork()).rejects.toThrow(/no mode as careful as this agent's \(“Always Ask”\)/);
      expect(created).toHaveLength(0);
    });

    it("refuses a running agent", async () => {
      const { created, fork } = await manually({ prefs: PREFS, sourceStatus: "running" });
      await expect(fork()).rejects.toThrow("This agent is working right now. Wait for its turn to finish, then continue it elsewhere.");
      expect(created).toHaveLength(0);
    });

    it("refuses a Codex source", async () => {
      const { created, fork } = await manually({ prefs: PREFS, sourceProvider: "codex" });
      await expect(fork()).rejects.toThrow("Only Claude agents can continue on OpenCode.");
      expect(created).toHaveLength(0);
    });
  });
});

describe("disabling an account", () => {
  it("moves its agents off and back, and won't disable the last usable account", async () => {
    const { service, store, reopened } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: new Date().toISOString() } },
        sessions: { [AGENT]: { accountId: HELLO, family: "claude", openedAt: new Date().toISOString() } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "" }),
    );
    const paseo = fakePaseo().paseo as never;

    const off = await service.setAccountEnabled(paseo, HELLO, false);
    expect(off.reopened).toEqual([AGENT]);
    let state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO); // kept for when it's enabled again

    await expect(service.setAccountEnabled(paseo, MAIN, false)).rejects.toThrow(/only Claude account in use/);

    const on = await service.setAccountEnabled(paseo, HELLO, true);
    expect(on.reopened).toEqual([AGENT]);
    state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toHaveLength(2);
  });
});

describe("usage readings", () => {
  const CREDITS = { balance: 57714.93, unlimited: false };
  const USE_CREDITS = preferences.schema.parse({ useCredits: true });
  const NEW_AGENT = "agent-new";
  const full = (credits: UsageRead["credits"]) => (): UsageRead => ({
    fetchedAt: new Date().toISOString(),
    windows: [{ id: "primary", label: "Weekly", usedPercent: 100, resetsAt: inFuture() }],
    error: null,
    cached: false,
    resets: null,
    credits,
  });
  const state = (limit: Partial<StoredAccount> = {}) => ({
    accounts: [{ ...account(MAIN, "marketing", "main"), ...limit }, account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null },
  });
  const limitedUntil = async (store: StateStore) => (await store.read()).accounts.find((a) => a.id === MAIN)?.limitedUntil ?? null;
  const unused = () => ({ kind: "window" as const, resetsAt: inFuture(), message: "" });
  /** Dates the account's limit an hour back, so usage readings may second-guess it. */
  const settle = (store: StateStore) =>
    store.update((draft) => {
      const main = draft.accounts.find((a) => a.id === MAIN);
      if (main) main.limitedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    });
  /** The account a brand-new agent's session opens on. */
  const newAgentOpensOn = async (service: Service, store: StateStore, paseo: unknown) => {
    await service.onSessionOpen(
      { agentId: NEW_AGENT, provider: "claude", reason: "create", purpose: "interactive", env: {} } as never,
      { paseo } as never,
    );
    return (await store.read()).sessions[NEW_AGENT]?.accountId;
  };

  it("doesn't take one model's full window for the whole account's limit", async () => {
    const opusFull = (): UsageRead => ({
      fetchedAt: new Date().toISOString(),
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 12, resetsAt: inFuture() },
        { id: "seven_day", label: "Weekly", usedPercent: 40, resetsAt: inFuture() },
        { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 100, resetsAt: inFuture() },
      ],
      error: null,
      cached: false,
      resets: null,
    });
    const { service, store, paseo } = await setUp(state(), unused, { usage: opusFull });
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).toBeNull();
    expect(await newAgentOpensOn(service, store, paseo)).toBe(MAIN);
  });

  it("takes a full window without credits for a limit, whatever the setting", async () => {
    for (const prefs of [preferences.schema.parse({}), USE_CREDITS]) {
      const { service, store } = await setUp(state(), unused, { usage: full(null) });
      service.setPreferences(prefs);
      await service.refreshUsage(MAIN, true);
      expect(await limitedUntil(store)).not.toBeNull();
    }
  });

  it("still takes a full window for a limit while credits are left, so new agents start elsewhere", async () => {
    const { service, store, paseo } = await setUp(state(), unused, { usage: full(CREDITS) });
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).not.toBeNull();
    expect(await newAgentOpensOn(service, store, paseo)).toBe(HELLO);
  });

  it("keeps an account going on its credits when told to use them", async () => {
    const { service, store, paseo } = await setUp(state(), unused, { usage: full(CREDITS) });
    service.setPreferences(USE_CREDITS);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).toBeNull();
    expect(await newAgentOpensOn(service, store, paseo)).toBe(MAIN);
  });

  it("clears a limit a reading found once told to use the credits", async () => {
    const { service, store } = await setUp(state(), unused, { usage: full({ balance: null, unlimited: true }) });
    await service.refreshUsage(MAIN, true);
    await settle(store);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).not.toBeNull(); // not while the setting is off

    service.setPreferences(USE_CREDITS);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).toBeNull();
  });

  it("leaves a limit a turn ran into until it resets, credits or not", async () => {
    // The provider stopped the turn, so the credits didn't cover it: clearing the limit would only send new agents back.
    const { service, store, limitTurn } = await setUp(
      state(),
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your usage limit" }),
      { usage: full(CREDITS) },
    );
    service.setPreferences(USE_CREDITS);
    await limitTurn();
    await settle(store);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).not.toBeNull();
  });

  it("takes a limit saved without its source for a turn's", async () => {
    const { service, store } = await setUp(state({ limitedUntil: inFuture(), limitKind: "window" }), unused, { usage: full(CREDITS) });
    service.setPreferences(USE_CREDITS);
    await settle(store);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).not.toBeNull();
  });

  it("stores a reading that leaves credits out as having none", async () => {
    const { service, paseo } = await setUp(state(), unused);
    await service.refreshUsage(MAIN, true);
    const shown = (await service.view(paseo as never)).accounts.find((a) => a.id === MAIN);
    expect(shown?.usage?.credits).toBeNull();
  });
});

describe("changing the default account", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const stateWithLiveAgent = () => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null },
    bindings: {},
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });

  it("moves agents that follow the default", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({
      kind: "window",
      resetsAt: inFuture(),
      message: "",
    }));
    const paseo = fakePaseo().paseo as never;

    const summary = await service.setDefault(paseo, HELLO);
    expect(summary.reopened).toEqual([AGENT]);
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).defaults.claude).toBe(HELLO);
  });

  it("leaves running agents where they are when that preference is off", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({
      kind: "window",
      resetsAt: inFuture(),
      message: "",
    }));
    service.setPreferences(preferences.schema.parse({ moveAgentsOnDefaultChange: false }));
    const paseo = fakePaseo().paseo as never;

    const summary = await service.setDefault(paseo, HELLO);
    expect(summary.reopened).toEqual([]);
    expect(reopened).toEqual([]);
    const state = await store.read();
    expect(state.defaults.claude).toBe(HELLO); // the default still changed, for new agents
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    // Pinned where it runs, so resuming it later doesn't drift to the new default either.
    expect(state.bindings[AGENT]).toMatchObject({ accountId: MAIN });
  });

  const WORK = "claude-work";
  const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
  const KEEP = preferences.schema.parse({ moveAgentsOnDefaultChange: false });
  const NOTHING_MOVED = { reopened: [], deferred: [], failed: [], continuedIn: null };
  const session = (accountId: string) => ({ accountId, family: "claude" as const, openedAt });

  /** Several agents, each answering for itself. `reopened` lists the ones Paseo was asked to reload. */
  async function setUpAgents(
    state: Partial<StoredState>,
    listed: Array<{ id: string; status: string; provider?: string; archived?: boolean }>,
    options: { claude?: Partial<FamilyAdapter>; onList?: (service: Service, context: never) => void } = {},
  ) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) => Object.assign(draft, state));
    const agents = listed.map(({ id, status, provider, archived }) => ({
      id,
      provider: provider ?? "claude",
      status,
      archivedAt: archived ? "2026-09-23T08:00:00.000Z" : null,
      lastUserMessageAt: openedAt,
    }));
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      agents: {
        list: async () => {
          options.onList?.(service, context);
          return { entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } };
        },
        ref: (id: string) => ({
          refresh: async () => ({ agent: agents.find((agent) => agent.id === id) }),
          send: async () => undefined,
          timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
        }),
      },
    };
    const context = { paseo } as never;
    const reopened: string[] = [];
    const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" });
    const service: Service = new Service(
      { claude: { ...claudeAdapter(hit), ...options.claude }, codex: { ...claudeAdapter(hit), family: "codex", portable: false } as FamilyAdapter },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      {
        locate: async () => "/usr/local/bin/paseo",
        reopen: async (id: string) => {
          reopened.push(id);
          const provider = agents.find((agent) => agent.id === id)?.provider;
          await service.onSessionOpen({ agentId: id, provider, reason: "refresh", purpose: "interactive", env: {} } as never, context);
          return { ok: true as const };
        },
      } as unknown as Reopener,
    );
    service.setPreferences(KEEP);
    return { service, store, paseo: paseo as never, context, reopened };
  }

  it("moves an agent whose last turn failed when it's switched", async () => {
    // A failed turn leaves the agent in "error" with its session still open: its next message goes to
    // that session as it is, so only a reload moves it.
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: { failed: session(MAIN) },
      },
      [{ id: "failed", status: "error" }],
    );
    const summary = await service.setAgentAccount(paseo, "failed", WORK);
    expect(summary.reopened).toEqual(["failed"]);
    expect(reopened).toEqual(["failed"]);
    expect((await store.read()).sessions.failed?.accountId).toBe(WORK);
  });

  it("keeps each open agent that follows the default on the account it runs on, and nothing else", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null },
        bindings: { chosen: { accountId: MAIN, source: "user", at: openedAt } },
        sessions: {
          idle: session(WORK),
          busy: session(WORK),
          chosen: session(MAIN),
          closed: session(WORK),
          there: session(HELLO),
        },
      },
      [
        { id: "idle", status: "idle" },
        { id: "busy", status: "running" },
        { id: "unrouted", status: "idle" }, // opened before ZeroSub routed anything, so on the CLI login
        { id: "chosen", status: "idle" },
        { id: "closed", status: "closed" },
        { id: "there", status: "idle" }, // already on the new default
        { id: "chatgpt", status: "idle", provider: "codex" }, // a Claude default isn't its concern
      ],
    );

    expect(await service.setDefault(paseo, HELLO)).toEqual(NOTHING_MOVED);
    expect(reopened).toEqual([]);
    const state = await store.read();
    expect(state.defaults.claude).toBe(HELLO);
    const { bindings } = state;
    expect(bindings.idle).toMatchObject({ accountId: WORK, source: "auto" });
    expect(bindings.busy).toMatchObject({ accountId: WORK, source: "auto" });
    expect(bindings.unrouted).toMatchObject({ accountId: MAIN, source: "auto" });
    expect(bindings.chosen).toMatchObject({ accountId: MAIN, source: "user" });
    expect(bindings.closed).toBeUndefined();
    expect(bindings.there).toBeUndefined();
    expect(bindings.chatgpt).toBeUndefined();

    // Kept agents read as pinned, so their account button offers "Follow default"; the rest follow it.
    const routes = new Map((await service.view(paseo)).agents.map((route) => [route.agentId, route]));
    expect(routes.get("idle")).toMatchObject({ accountId: WORK, pinned: true, pendingAccountId: null });
    expect(routes.get("closed")).toMatchObject({ accountId: HELLO, pinned: false });
    expect(routes.get("there")).toMatchObject({ accountId: HELLO, pinned: false });
  });

  it("moves an agent whose account it can't stay on, as it would with the switch on", async () => {
    const cases: Array<[string, Partial<StoredAccount> | null]> = [
      ["at its limit", { limitedUntil: inFuture(), limitKind: "window" }],
      ["signed out", { signedIn: false }],
      ["disabled", { disabled: true }],
      ["removed", null],
    ];
    for (const [why, work] of cases) {
      const { service, store, paseo, reopened } = await setUpAgents(
        {
          accounts: [
            account(MAIN, "marketing", "main"),
            ...(work ? [{ ...account(WORK, "work", "managed"), ...work }] : []),
            account(HELLO, "hello", "managed"),
          ] as never,
          defaults: { claude: MAIN, codex: null },
          bindings: {},
          sessions: { stuck: session(WORK), fine: session(MAIN) },
        },
        [
          { id: "stuck", status: "idle" },
          { id: "fine", status: "idle" },
        ],
      );
      // Without automatic switching, changing the default is how a stuck agent gets out.
      service.setPreferences({ ...KEEP, autoSwitch: false });
      expect(await service.setDefault(paseo, HELLO), why).toEqual({ ...NOTHING_MOVED, reopened: ["stuck"] });
      expect(reopened, why).toEqual(["stuck"]);
      const state = await store.read();
      expect(state.sessions.stuck?.accountId, why).toBe(HELLO);
      expect(state.bindings.stuck, why).toBeUndefined();
      expect(state.bindings.fine, why).toMatchObject({ accountId: MAIN, source: "auto" });
    }
  });

  it("changes nothing when the account is already the default", async () => {
    const accounts = [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never;
    const agents = [
      { id: "idle", status: "idle" },
      { id: "busy", status: "running" },
    ];
    for (const prefs of [KEEP, preferences.schema.parse({})]) {
      const { service, store, paseo, reopened } = await setUpAgents(
        { accounts, defaults: { claude: WORK, codex: null }, bindings: {}, sessions: { idle: session(WORK), busy: session(WORK) } },
        agents,
      );
      service.setPreferences(prefs);
      expect(await service.setDefault(paseo, WORK)).toEqual(NOTHING_MOVED);
      expect((await store.read()).bindings).toEqual({});
      expect(reopened).toEqual([]);
    }

    // Until another account is chosen, the CLI login is the default.
    const { service, store, paseo, reopened } = await setUpAgents(
      { accounts, defaults: { claude: null, codex: null }, bindings: {}, sessions: { idle: session(MAIN), busy: session(MAIN) } },
      agents,
    );
    expect(await service.setDefault(paseo, MAIN)).toEqual(NOTHING_MOVED);
    const state = await store.read();
    expect(state.defaults.claude).toBe(MAIN);
    expect(state.bindings).toEqual({});
    expect(reopened).toEqual([]);
  });

  it("keeps an agent whose session is still being routed on the account it opens on", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let preparing = false;
    const { service, store, paseo, context, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null },
      },
      [{ id: "starting", status: "initializing" }],
      {
        claude: {
          prepareHome: async () => {
            if (preparing) return;
            preparing = true;
            await gate;
          },
        },
      },
    );
    // Routed by the old default, but it hasn't recorded where it opens yet.
    const opening = service.onSessionOpen(
      { agentId: "starting", provider: "claude", reason: "create", purpose: "interactive", env: {} } as never,
      context,
    );
    await vi.waitFor(() => expect(preparing).toBe(true));
    // A history session opened for the same agent meanwhile mustn't hide the one still being routed.
    await service.onSessionOpen({ agentId: "starting", provider: "claude", reason: "resume", purpose: "history", env: {} } as never, context);
    const changing = service.setDefault(paseo, HELLO);
    await vi.waitFor(async () => expect((await store.read()).defaults.claude).toBe(HELLO));
    release();
    const [summary, opened] = await Promise.all([changing, opening]);

    expect(opened?.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(tmpdir(), WORK) });
    const state = await store.read();
    expect(state.sessions.starting?.accountId).toBe(WORK);
    expect(state.bindings.starting).toMatchObject({ accountId: WORK, source: "auto" });
    expect(summary.reopened).toEqual([]);
    expect(reopened).toEqual([]);
  });

  it("leaves agents that are only starting now to the new default", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reloading: Promise<unknown> | undefined;
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null },
        bindings: {},
        sessions: { reloading: session(WORK) },
      },
      [
        { id: "fresh", status: "initializing" }, // listed before Paseo asked ZeroSub where to open it
        { id: "reloading", status: "idle" },
      ],
      {
        claude: { prepareHome: () => gate },
        // Paseo reloads this one after the default changed, while the open agents are being listed.
        onList: (service, context) => {
          reloading ??= service.onSessionOpen(
            { agentId: "reloading", provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never,
            context,
          );
        },
      },
    );
    expect(await service.setDefault(paseo, HELLO)).toEqual(NOTHING_MOVED);
    release();
    await reloading;
    const state = await store.read();
    expect(state.sessions.reloading?.accountId).toBe(HELLO);
    expect(state.bindings.reloading).toBeUndefined();
    expect(state.bindings.fresh).toBeUndefined();
    expect(reopened).toEqual([]);
  });

  it("keeps open agents on the CLI login when the first default is chosen", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: null, codex: null },
        sessions: { routed: session(MAIN) },
      },
      [
        { id: "routed", status: "idle" },
        { id: "unrouted", status: "running" },
      ],
    );
    await service.setDefault(paseo, HELLO);
    const state = await store.read();
    expect(state.defaults.claude).toBe(HELLO);
    expect(state.bindings.routed).toMatchObject({ accountId: MAIN, source: "auto" });
    expect(state.bindings.unrouted).toMatchObject({ accountId: MAIN, source: "auto" });
    expect(reopened).toEqual([]);
  });

  it("still moves a kept agent when its account hits a limit", async () => {
    const { service, store, reopened, notes, limitTurn } = await setUp(stateWithLiveAgent(), () => ({
      kind: "window",
      resetsAt: inFuture(),
      message: "You've hit your session limit",
    }));
    service.setPreferences(KEEP);
    await service.setDefault(fakePaseo().paseo as never, HELLO);
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: MAIN, source: "auto" });

    await limitTurn();
    const state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: HELLO, source: "auto" });
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
  });

  it("moves a kept agent to the new default when asked to follow it", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({ kind: "window", resetsAt: inFuture(), message: "" }));
    service.setPreferences(KEEP);
    const paseo = fakePaseo().paseo as never;
    await service.setDefault(paseo, HELLO);
    expect(reopened).toEqual([]);

    await service.setAgentAccount(paseo, AGENT, null); // "Follow default" and `/account default`
    const state = await store.read();
    expect(state.bindings[AGENT]).toBeUndefined();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
  });

  it("pins ChatGPT threads as before, since they can't move either way", async () => {
    const codex = (id: string, label: string, kind: "main" | "managed") => ({ ...account(id, label, kind), family: "codex" });
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [codex(CODEX_MAIN, "chatgpt", "main"), codex("codex-work", "work", "managed")] as never,
        defaults: { claude: null, codex: CODEX_MAIN },
        sessions: { thread: { accountId: CODEX_MAIN, family: "codex", openedAt } },
      },
      [
        { id: "thread", status: "idle", provider: "codex" },
        { id: "archived", status: "closed", provider: "codex", archived: true },
      ],
    );
    await service.setDefault(paseo, "codex-work");
    const { bindings } = await store.read();
    expect(bindings.thread).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(bindings.archived).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(reopened).toEqual([]);
  });
});

describe("a reading past its reset", () => {
  it("renews the sign-in, so an idle account that sat full is read again once it resets", async () => {
    const NOW = Date.parse("2026-10-24T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      const store = new StateStore(join(root, "state.json"));
      await store.update((draft) => Object.assign(draft, { accounts: [account(MAIN, "main", "main")], defaults: { claude: MAIN, codex: null } }));
      const windows = (weekly: number) => [{ id: "seven_day", label: "Weekly", usedPercent: weekly, resetsAt: new Date(NOW + 72 * 3_600_000).toISOString() }];
      // Like Claude with an expired sign-in: nothing is read unless the CLI renews it first.
      const renewals: boolean[] = [];
      let signedIn = true;
      const usage = async (_home: string | null, options: { renewLogin?: boolean } = {}): Promise<UsageRead> => {
        renewals.push(Boolean(options.renewLogin));
        const fetchedAt = new Date().toISOString();
        if (!signedIn && !options.renewLogin) return { fetchedAt, windows: [], error: "Usage shows up after this account is next used.", cached: false, resets: null };
        return { fetchedAt, windows: windows(signedIn ? 100 : 0), error: null, cached: false, resets: null };
      };
      const claude = { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), usage };
      const service = new Service(
        { claude, codex: { ...claude, family: "codex", portable: false } as FamilyAdapter },
        store,
        { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
        { locate: async () => "/usr/local/bin/paseo" } as unknown as Reopener,
      );
      service.setPreferences(preferences.schema.parse({}));
      await service.refreshUsage(MAIN, true);
      signedIn = false;
      vi.setSystemTime(NOW + 3_600_000);
      await service.refreshUsage(MAIN, true);
      vi.setSystemTime(NOW + 73 * 3_600_000);
      await service.refreshUsage(MAIN, true);
      expect(renewals).toEqual([false, false, true]);
      // The renewed reading replaces the stale one, so the card and Up next see the reset.
      const shown = (await service.view(fakePaseo().paseo as never)).accounts.find((entry) => entry.id === MAIN)?.usage;
      expect(shown?.error).toBeNull();
      expect(shown?.windows.map((window) => window.usedPercent)).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("renewing an expired sign-in in the background", () => {
  const NOW = Date.parse("2026-10-24T12:00:00Z");
  const MINUTE = 60_000;
  const minutesIn = () => (Date.now() - NOW) / MINUTE;
  const fiveHour = (usedPercent: number, resetsAt: number) => ({ id: "five_hour", label: "5-hour", usedPercent, resetsAt: new Date(resetsAt).toISOString() });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A service whose one account is the Claude CLI login, read through `usage`. */
  async function setUpAccount(usage: FamilyAdapter["usage"], patch: Partial<StoredAccount> = {}) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) =>
      Object.assign(draft, { accounts: [{ ...account(MAIN, "main", "main"), ...patch }], defaults: { claude: MAIN, codex: null } }),
    );
    const claude = { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), usage };
    const service = new Service(
      { claude, codex: { ...claude, family: "codex", portable: false } as FamilyAdapter },
      store,
      { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo" } as unknown as Reopener,
    );
    service.setPreferences(preferences.schema.parse({}));
    return { service, store };
  }

  /**
   * An account read full two hours before NOW, in a 5-hour window that reset an hour before NOW.
   * Its sign-in has expired since, and renewing it never works (revoked, offline, or `claude`
   * missing), so the reading stays past its reset. `reads` and `asked` are the minutes after NOW at
   * which it was read, and at which a read asked to renew it.
   */
  async function setUpPastReset(patch: Partial<StoredAccount> = {}) {
    let expired = false;
    const reads: number[] = [];
    const asked: number[] = [];
    const { service, store } = await setUpAccount(async (_home, options = {}) => {
      const fetchedAt = new Date().toISOString();
      if (!expired) return { fetchedAt, windows: [fiveHour(100, NOW - 60 * MINUTE)], error: null, cached: false, resets: null };
      reads.push(minutesIn());
      if (options.renewLogin) asked.push(minutesIn());
      return { fetchedAt, windows: [], error: "Usage shows up after this account is next used.", cached: false, resets: null };
    }, patch);
    vi.setSystemTime(NOW - 120 * MINUTE);
    await service.refreshUsage(MAIN);
    expired = true;
    return { service, store, reads, asked };
  }

  /** A read nobody asked to renew the sign-in for, like the upkeep tick's, `minute` minutes after NOW. */
  async function readAt(service: Service, minute: number) {
    vi.setSystemTime(NOW + minute * MINUTE);
    await service.refreshUsage(MAIN);
  }

  it("asks to renew at most every 30 minutes when renewing never works", async () => {
    const { service, reads, asked } = await setUpPastReset();
    // The default account is read every 5 minutes.
    const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
    for (const minute of minutes) await readAt(service, minute);
    expect(reads).toEqual(minutes);
    expect(asked).toEqual([0, 30, 60]);
  });

  it("doesn't renew a disabled account's sign-in", async () => {
    const { service, store, asked } = await setUpPastReset({ disabled: true });
    for (const minute of [0, 20, 40, 60]) await readAt(service, minute);
    expect(asked).toEqual([]);
    // Enabled again, the next read renews it.
    await store.update((draft) => {
      draft.accounts[0]!.disabled = false;
    });
    await readAt(service, 65);
    expect(asked).toEqual([65]);
  });

  it("renews a window-limited account with no live reading, so a reset used elsewhere lifts the limit", async () => {
    // The 5-hour window filled 10 minutes before NOW and resets 4 hours after it. The sign-in has
    // expired since, so reads only get Claude Code's cached copy, older than the last live reading,
    // until one renews it. By then a reset used on another machine has emptied the window.
    const resetsAt = NOW + 240 * MINUTE;
    let fresh = true;
    let used = 100;
    const asked: number[] = [];
    const { service, store } = await setUpAccount(async (_home, options = {}) => {
      if (options.renewLogin) {
        asked.push(minutesIn());
        fresh = true;
      }
      if (!fresh) return { fetchedAt: new Date(NOW - 15 * MINUTE).toISOString(), windows: [fiveHour(100, resetsAt)], error: null, cached: true, resets: null };
      return { fetchedAt: new Date().toISOString(), windows: [fiveHour(used, resetsAt)], error: null, cached: false, resets: null };
    });
    const limitedUntil = async () => (await store.read()).accounts[0]!.limitedUntil;

    await readAt(service, -10); // full, so the reading records the window limit
    expect(await limitedUntil()).not.toBeNull();
    fresh = false;
    await readAt(service, 0); // only the cached copy
    used = 0;
    await readAt(service, 1); // renews and finds room, but a limit 11 minutes old is still trusted (LIMIT_TRUST_MS)
    expect(await limitedUntil()).not.toBeNull();
    await readAt(service, 6); // live without renewing now, and the limit is old enough to lift
    expect(await limitedUntil()).toBeNull();
    expect(asked).toEqual([1]);
  });

  it("still renews on every explicit refresh (↻)", async () => {
    const { service, asked } = await setUpPastReset();
    const paseo = fakePaseo().paseo as never;
    await readAt(service, 0);
    for (const minute of [1, 2]) {
      vi.setSystemTime(NOW + minute * MINUTE);
      await service.view(paseo, true);
    }
    // An explicit refresh counts as an attempt too, so the next background renewal waits 30 minutes from it.
    await readAt(service, 30);
    await readAt(service, 32);
    expect(asked).toEqual([0, 1, 2, 32]);
  });
});

describe("the account button's reason row", () => {
  it("names a near weekly reset as why an agent started on its account, only while it's still there", async () => {
    const { service, store } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "balance", at: new Date().toISOString(), selectionReason: "headroom" } },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "" }),
    );
    const paseo = fakePaseo().paseo as never;
    const route = async () => (await service.view(paseo)).agents.find((entry) => entry.agentId === AGENT);

    // Most room left is how balancing always picks, so it gets no row.
    expect((await route())?.accountId).toBe(HELLO);
    expect((await route())?.selectionReason).toBeUndefined();

    await store.update((draft) => {
      draft.bindings[AGENT]!.selectionReason = "weekly_reset";
    });
    expect(await route()).toMatchObject({ accountId: HELLO, selectionReason: "weekly_reset" });

    // Moved off it for now, so the account the menu shows wasn't picked for its reset.
    await store.update((draft) => {
      draft.accounts.find((entry) => entry.id === HELLO)!.limitedUntil = inFuture();
    });
    expect((await route())?.accountId).toBe(MAIN);
    expect((await route())?.selectionReason).toBeUndefined();
  });
});
