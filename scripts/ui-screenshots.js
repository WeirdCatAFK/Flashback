#!/usr/bin/env node
/**
 * Visual regression aid for the src/ui revision.
 *
 * Launches Vite + Electron with a remote-debugging port, drives the activity bar
 * over the Chrome DevTools Protocol, and captures every nav view in each theme.
 * `--diff` compares two capture folders pixel-by-pixel (decoded in a canvas inside
 * the running page — Node has no image decoder) and writes a red-highlighted
 * `<view>.diff.png` beside a percentage per view.
 *
 * Usage:
 *   node scripts/ui-screenshots.js --out <dir> [--themes light-workbench,dark-cherry] [--views documents,trainer]
 *   node scripts/ui-screenshots.js --diff <baseDir> <newDir>
 *
 * Needs nothing running; it starts and stops the app itself. Only navigates and
 * sets `data-theme` — it never writes to the vault. Node >= 22 (global WebSocket).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9222;
const VITE_URL = "http://localhost:51234";
const DEFAULT_THEMES = ["light-workbench", "dark-cherry"];
const DEFAULT_VIEWS = [
  "documents",
  "flashcards",
  "decks",
  "graph",
  "trainer",
  "stats",
  "diary",
  "seal",
  "manage",
  "config",
];

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(name);

// ── CDP client ──────────────────────────────────────────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    const c = new Cdp(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.text +
          " " +
          (r.exceptionDetails.exception?.description ?? ""),
      );
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function findPage(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`)
      ).json();
      const page = list.find(
        (t) => t.type === "page" && t.url.startsWith(VITE_URL),
      );
      if (page) return page;
    } catch {}
    await sleep(1000);
  }
  throw new Error("app page not found on the debugging port");
}

// ── launch / teardown ───────────────────────────────────────────────────────

function launch() {
  const shell = process.platform === "win32";
  const vite = spawn(shell ? "npx vite" : "npx", shell ? [] : ["vite"], {
    shell,
    stdio: "ignore",
    detached: !shell,
  });
  const cmd = `npx cross-env NODE_ENV=development electron . --remote-debugging-port=${PORT}`;
  const electron = spawn(
    shell ? cmd : "npx",
    shell ? [] : cmd.split(" ").slice(1),
    { shell, stdio: "ignore", detached: !shell },
  );
  return { vite, electron };
}

function kill(proc) {
  if (!proc?.pid) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else process.kill(-proc.pid, "SIGTERM");
}

/** npx re-spawns its target, so the tree under our pid is not the whole story: also kill whatever holds the ports. */
function killByPort(...ports) {
  if (process.platform !== "win32") return;
  const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout || "";
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/.test(line)) continue;
    const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m && ports.includes(Number(m[1])))
      spawnSync("taskkill", ["/pid", m[2], "/T", "/F"], { stdio: "ignore" });
  }
}

function teardown(procs) {
  kill(procs.electron);
  kill(procs.vite);
  killByPort(PORT, 51234);
}

// ── capture ─────────────────────────────────────────────────────────────────

async function capture(outDir, themes, views) {
  fs.mkdirSync(outDir, { recursive: true });
  const procs = launch();
  let cdp;
  try {
    const page = await findPage();
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);

    await cdp.send("Page.enable");
    for (let i = 0; i < 60; i++) {
      if (
        await cdp.eval(
          `!!document.querySelector('[data-tour="nav-documents"]')`,
        )
      )
        break;
      await sleep(1000);
    }
    await sleep(1500);
    const originalTheme = await cdp.eval(
      `document.documentElement.getAttribute('data-theme')`,
    );
    for (const theme of themes) {
      await cdp.eval(
        `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`,
      );
      for (const view of views) {
        await cdp.eval(
          `(() => { const b = document.querySelector('[data-tour="nav-${view}"]'); if (!b) return false; b.click(); return true; })()`,
        );
        await sleep(view === "graph" ? 3000 : 1500);
        const { data } = await cdp.send("Page.captureScreenshot", {
          format: "png",
        });
        fs.writeFileSync(
          path.join(outDir, `${theme}--${view}.png`),
          Buffer.from(data, "base64"),
        );
        console.log(`✓ ${theme}/${view}`);
      }
    }
    if (originalTheme)
      await cdp.eval(
        `document.documentElement.setAttribute('data-theme', ${JSON.stringify(originalTheme)})`,
      );
  } finally {
    cdp?.close();
    teardown(procs);
  }
}

// ── diff ────────────────────────────────────────────────────────────────────

const DIFF_FN = `
async (a, b) => {
  const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
  const cv = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
  const da = cv(ia), db = cv(ib);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const ox = out.getContext('2d'); ox.drawImage(ib, 0, 0);
  const od = ox.getImageData(0, 0, w, h);
  let diff = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.abs(da[i]-db[i]) + Math.abs(da[i+1]-db[i+1]) + Math.abs(da[i+2]-db[i+2]);
    if (d > 48) { diff++; od.data[i] = 255; od.data[i+1] = 0; od.data[i+2] = 0; od.data[i+3] = 255; }
    else { od.data[i+3] = 90; }
  }
  ox.putImageData(od, 0, 0);
  return { pct: (100 * diff / (w * h)).toFixed(2), png: out.toDataURL('image/png') };
}`;

async function diff(baseDir, newDir) {
  const procs = launch();
  let cdp;
  try {
    const page = await findPage();
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await sleep(2000);
    const files = fs
      .readdirSync(baseDir)
      .filter((f) => f.endsWith(".png") && !f.endsWith(".diff.png"));
    const rows = [];
    for (const f of files) {
      const other = path.join(newDir, f);
      if (!fs.existsSync(other)) {
        rows.push([f, "missing"]);
        continue;
      }
      const a =
        "data:image/png;base64," +
        fs.readFileSync(path.join(baseDir, f)).toString("base64");
      const b =
        "data:image/png;base64," + fs.readFileSync(other).toString("base64");
      const { pct, png } = await cdp.eval(
        `(${DIFF_FN})(${JSON.stringify(a)}, ${JSON.stringify(b)})`,
      );
      fs.writeFileSync(
        path.join(newDir, f.replace(/\.png$/, ".diff.png")),
        Buffer.from(png.split(",")[1], "base64"),
      );
      rows.push([f, `${pct}%`]);
    }
    console.log(rows.map(([f, p]) => `${p.padStart(8)}  ${f}`).join("\n"));
  } finally {
    cdp?.close();
    teardown(procs);
  }
}

if (has("--diff")) {
  const [base, next] = argv.slice(argv.indexOf("--diff") + 1);
  await diff(path.resolve(base), path.resolve(next));
} else {
  const out = opt("--out");
  if (!out) {
    console.error("usage: --out <dir> | --diff <base> <new>");
    process.exit(2);
  }
  const themes = (opt("--themes") || DEFAULT_THEMES.join(",")).split(",");
  const views = (opt("--views") || DEFAULT_VIEWS.join(",")).split(",");
  await capture(path.resolve(out), themes, views);
}
