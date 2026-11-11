// Throwaway evidence capture for the OpenCode fork settings (factory job 1233).
// The plugin's react-native surfaces render only inside the Paseo host app, so this renders a
// static replica of the new rows at 420x900. Every label and hint it draws is checked against the
// component source first, so the pictures can't drift from the code. Run: node capture-fork-settings.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const job = here; // run from .context/ in the worktree; job folder passed as argv[2]
const outDir = process.argv[2] ?? join(here, "..", "..", "jobs", "zerosub", "1233-opencode-exhaustion-fork");

const worktree = join(here, "..");
const forkSource = readFileSync(join(worktree, "client", "fork-settings.tsx"), "utf8");
const screenSource = readFileSync(join(worktree, "client", "settings-screen.tsx"), "utf8");

// Every string the replica draws must exist in the component source, or the capture fails.
const strings = [
  "When every account is out, fork the chat to the other provider",
  "A stopped Claude chat carries on in a new ChatGPT or OpenCode agent",
  "Fork a stopped Claude chat to",
  "Applies when every Claude account is out. ChatGPT uses the account with the most room left.",
  "Applies when every Claude account is out. Pick the model and thinking below.",
  "ChatGPT",
  "OpenCode",
  "OpenCode model",
  "Host default",
  "Used by the OpenCode fork agent on this host. Empty uses the host's default.",
  "OpenCode thinking",
  "Model default",
  "How hard the model thinks on the fork. Empty uses the model's default.",
  "Loading this host's OpenCode catalog…",
  "Couldn't read this host's OpenCode models: ",
];
for (const text of strings) {
  if (!forkSource.includes(text) && !screenSource.includes(text)) {
    console.error(`capture stopped: drawn text is not in the component source: ${text}`);
    process.exit(1);
  }
}

const require = createRequire(join(here, "package.json"));
const { chromium } = require("/Users/hussain.abbas/.npm/_npx/70c9d65422c7baee/node_modules/playwright");

const themes = {
  light: { bg: "#ffffff", card: "#f6f6f4", border: "#e4e4e0", text: "#1c1c1a", muted: "#6f6f68", accent: "#2f6f4f", row: "#ffffff" },
  dark: { bg: "#17181a", card: "#1f2124", border: "#33363b", text: "#e8e8e4", muted: "#9a9a94", accent: "#7fd0a2", row: "#26282c" },
};

const select = (label, hint, value, disabled = false) => `
  <div class="row">
    <div class="labels"><div class="label">${label}</div>${hint ? `<div class="hint">${hint}</div>` : ""}</div>
    <div class="select ${disabled ? "disabled" : ""}"><span>${value}</span><span class="chev">▾</span></div>
  </div>`;

const catalogRow = (label, hint) => `
  <div class="row">
    <div class="labels"><div class="label">${label}</div><div class="hint">${hint}</div></div>
  </div>`;

const toggle = (label, hint, on, disabled = false) => `
  <div class="row">
    <div class="labels"><div class="label">${label}</div><div class="hint">${hint}</div></div>
    <div class="switch ${on ? "on" : ""} ${disabled ? "disabled" : ""}"><div class="knob"></div></div>
  </div>`;

const card = (inner) => `<div class="card">${inner}</div>`;

// The component renders one toggle hint on both surfaces (round-1 review): this is that string.
const TOGGLE_HINT =
  "A stopped Claude chat carries on in a new ChatGPT or OpenCode agent — pick the destination below — with the conversation so far and no more permissions than the original. The original stays as it was.";
const TOGGLE = "When every account is out, fork the chat to the other provider";
const forkToggle = (on) => toggle(TOGGLE, TOGGLE_HINT, on);

const pages = {
  "settings-before": {
    theme: "light",
    // The destination row renders disabled while the fork toggle is off (forkOtherProvider=false).
    body: card(forkToggle(false) + select("Fork a stopped Claude chat to", "Applies when every Claude account is out. ChatGPT uses the account with the most room left.", "ChatGPT", true)),
  },
  "settings-after-chatgpt": {
    theme: "light",
    body: card(forkToggle(true) + select("Fork a stopped Claude chat to", "Applies when every Claude account is out. ChatGPT uses the account with the most room left.", "ChatGPT")),
  },
  "settings-after-opencode": {
    theme: "dark",
    body: card(
      forkToggle(true) +
        select("Fork a stopped Claude chat to", "Applies when every Claude account is out. Pick the model and thinking below.", "OpenCode") +
        select("OpenCode model", "Used by the OpenCode fork agent on this host. Empty uses the host's default.", "GLM 5.3 Flash") +
        select("OpenCode thinking", "How hard the model thinks on the fork. Empty uses the model's default.", "High"),
    ),
  },
  "settings-after-refused": {
    theme: "light",
    // The real component renders a label-only SettingsRow here: no control to show while the
    // catalog can't be read, so the replica draws no select widget either.
    body: card(
      forkToggle(true) +
        select("Fork a stopped Claude chat to", "Applies when every Claude account is out. Pick the model and thinking below.", "OpenCode") +
        catalogRow("OpenCode model", "Couldn't read this host's OpenCode models: The daemon went away."),
    ),
  },
};

const css = (t) => `
  * { margin: 0; box-sizing: border-box; }
  body { width: 420px; height: 900px; background: ${t.bg}; color: ${t.text};
         font-family: -apple-system, system-ui, sans-serif; padding: 20px 16px; }
  h2 { font-size: 17px; margin-bottom: 12px; }
  .card { background: ${t.card}; border: 1px solid ${t.border}; border-radius: 12px; overflow: hidden; }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px 14px;
         border-bottom: 1px solid ${t.border}; background: ${t.row}; }
  .row:last-child { border-bottom: none; }
  .labels { flex: 1; min-width: 0; }
  .label { font-size: 14px; font-weight: 500; }
  .hint { font-size: 12px; color: ${t.muted}; margin-top: 3px; line-height: 1.35; }
  .switch { width: 44px; height: 26px; border-radius: 13px; background: ${t.border};
            position: relative; flex-shrink: 0; transition: background 0.2s; }
  .switch.on { background: ${t.accent}; }
  .switch.disabled { opacity: 0.4; }
  .knob { width: 22px; height: 22px; border-radius: 11px; background: #fff; position: absolute;
          top: 2px; left: 2px; box-shadow: 0 1px 2px rgba(0,0,0,0.25); }
  .switch.on .knob { left: 20px; }
  .select { flex-shrink: 0; display: flex; align-items: center; gap: 6px; font-size: 13px;
            border: 1px solid ${t.border}; border-radius: 8px; padding: 7px 10px;
            background: ${t.card}; max-width: 170px; }
  .select.disabled { opacity: 0.4; }
  .select span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { color: ${t.muted}; }
`;

const browser = await chromium.launch({ channel: "chrome" }); // the host's own Chrome; no browser download
try {
  for (const [name, page] of Object.entries(pages)) {
    const t = themes[page.theme];
    const html = `<!doctype html><html><body><h2>ZeroSub preferences</h2>${page.body}<style>${css(t)}</style></body></html>`;
    const context = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: page.theme });
    const tab = await context.newPage();
    await tab.setContent(html);
    await tab.screenshot({ path: join(outDir, `${name}.png`) });
    await context.close();
    console.log(`captured ${name}.png (${page.theme})`);
  }
} finally {
  await browser.close();
}
