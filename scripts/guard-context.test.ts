import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "guard-context.mjs");
let repo: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8" });
const put = async (path: string) => {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), "scratch\n");
};
/** The guard's exit status in the synthetic repository. */
const guard = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" }).status;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "zerosub-guard-"));
  git("init", "-q", "-b", "main");
  await put("README.md");
  git("add", "README.md");
  git("commit", "-q", "-m", "base");
  git("branch", "base");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("guard:context", () => {
  it.each([".context/x", "client/.context/x", "a/b/.context/é", "client/.context/a\nb"])("rejects a staged %j", async (path) => {
    await put(path);
    git("add", "-f", "--", path);
    expect(guard()).toBe(1);
  });

  it.each(["client/x.context/y", "client/context/y", "notes.context"])("passes an ordinary staged %j", async (path) => {
    await put(path);
    git("add", "--", path);
    expect(guard()).toBe(0);
  });

  it("rejects a nested .context path committed and removed again, while the index is clean", async () => {
    await put("client/.context/probe.mjs");
    git("add", "-f", "--", "client/.context/probe.mjs");
    git("commit", "-q", "-m", "scratch");
    git("rm", "-q", "--", "client/.context/probe.mjs");
    git("commit", "-q", "-m", "remove scratch");
    expect(guard()).toBe(0);
    expect(guard("--history", "base")).toBe(1);
  });

  it("passes a history with no .context path", async () => {
    await put("client/x.ts");
    git("add", "--", "client/x.ts");
    git("commit", "-q", "-m", "work");
    expect(guard("--history", "base")).toBe(0);
  });
});
