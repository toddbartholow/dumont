// Installed-app smoke test (#42). Drives the release binary through tauri-driver,
// so it covers what the vitest suite cannot: the real Rust commands, the real
// webview, and state that has to survive the process exiting.
//
//   node smoke.mjs <path to the dumont binary>
//
// Linux only for now: tauri-driver needs WebKitWebDriver (webkit2gtk-driver) and
// a display. CI runs it under xvfb-run and dbus-run-session. Point XDG_CONFIG_HOME
// and XDG_DATA_HOME at an empty directory, or it reads and writes your own
// settings and session.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Key, remote } from "webdriverio";

const app = resolve(process.argv[2] ?? "../src-tauri/target/release/dumont");
const PORT = 4444;
const WAIT = 20_000;

const dir = mkdtempSync(join(tmpdir(), "dumont-smoke-"));
const file = join(dir, "smoke.md");
writeFileSync(file, "# Smoke test\n\nFirst paragraph.\n");
const onDisk = () => readFileSync(file, "utf8");

// tauri-driver inherits this to the app, whose webview only accepts an automation
// session when it is set.
const driver = spawn("tauri-driver", ["--port", String(PORT)], {
    stdio: "inherit",
    env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: "true" },
});
driver.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`tauri-driver exited with ${code}`);
});

async function waitForDriver() {
    const until = Date.now() + WAIT;
    while (Date.now() < until) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/status`);
            if (res.ok) return;
        } catch {
            // Not listening yet.
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("tauri-driver never started listening");
}

function launch(args) {
    return remote({
        hostname: "127.0.0.1",
        port: PORT,
        logLevel: "warn",
        connectionRetryCount: 0,
        capabilities: {
            // WebKitWebDriver speaks classic WebDriver only; without this wdio asks
            // for a BiDi socket and the session never starts.
            "wdio:enforceWebDriverClassic": true,
            "tauri:options": { application: app, args },
        },
    });
}

// The window is gone once the app quits, so ending the session can fail or hang.
// Either is fine: the session is over.
async function endSession(browser) {
    await Promise.race([
        browser.deleteSession().catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
    ]);
}

async function waitForText(browser, text) {
    await browser.waitUntil(
        async () => (await browser.execute(() => document.body.innerText)).includes(text),
        { timeout: WAIT, timeoutMsg: `"${text}" never appeared in the window` },
    );
}

async function waitForDisk(browser, text) {
    await browser.waitUntil(async () => onDisk().includes(text), {
        timeout: WAIT,
        timeoutMsg: `"${text}" never reached ${file}`,
    });
}

async function expectTab(browser, name) {
    const tab = await browser.$(`[role="tab"][title="${name}"]`);
    await tab.waitForExist({ timeout: WAIT, timeoutMsg: `no tab for ${name}` });
}

// Where a failing step leaves the window's text and a screenshot. CI uploads it.
const failures = resolve(process.env.SMOKE_ARTIFACTS ?? join(dir, "artifacts"));

async function step(browser, name, fn) {
    process.stdout.write(`- ${name} ... `);
    try {
        await fn();
    } catch (err) {
        console.log("FAILED");
        mkdirSync(failures, { recursive: true });
        const slug = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
        await browser
            .execute(() => document.body.innerText)
            .then((text) => {
                writeFileSync(join(failures, `${slug}.txt`), text);
                console.log(`--- window text ---\n${text}\n---`);
            })
            .catch(() => {});
        await browser.saveScreenshot(join(failures, `${slug}.png`)).catch(() => {});
        throw err;
    }
    console.log("ok");
}

async function run() {
    await waitForDriver();

    let browser = await launch([file]);
    try {
        await step(browser, "a file passed on the command line opens as a tab", async () => {
            await expectTab(browser, "smoke.md");
            // Reader view is the default. The heading also holds its copy-link
            // icon, so match on containment rather than its exact text.
            await browser.waitUntil(
                async () => {
                    const h1 = await browser.$(".markdown-body h1");
                    return (await h1.isExisting()) && (await h1.getText()).includes("Smoke test");
                },
                { timeout: WAIT, timeoutMsg: "the preview never showed the file's heading" },
            );
        });

        await step(browser, "an edit saved with Ctrl+S reaches the disk", async () => {
            await browser.keys([Key.Ctrl, "e"]);
            const editor = await browser.$(".cm-content");
            await editor.waitForDisplayed({ timeout: WAIT });
            await editor.click();
            await browser.keys([Key.Ctrl, Key.End]);
            await browser.keys([Key.Enter, ..."Saved by the smoke test."]);
            await browser.keys([Key.Ctrl, "s"]);
            await waitForDisk(browser, "Saved by the smoke test.");
        });

        await step(browser, "closing with unsaved changes asks, and Save writes them", async () => {
            await browser.keys([..." Unsaved tail."]);
            await (await browser.$('button[aria-label="Close"]')).click();
            const dialog = await browser.$('[role="alertdialog"]');
            await dialog.waitForDisplayed({ timeout: WAIT });
            assert.match(await dialog.getText(), /save them before closing/i);
            assert.ok(!onDisk().includes("Unsaved tail."), "saved before the dialog was answered");
            await (await dialog.$("button=Save")).click();
            await waitForDisk(browser, "Unsaved tail.");
        });
    } finally {
        await endSession(browser);
    }

    // Relaunch with no arguments: the session has to come back from what the first
    // process left behind.
    browser = await launch([]);
    try {
        await step(browser, "a relaunch restores the open tab and its saved text", async () => {
            await expectTab(browser, "smoke.md");
            await waitForText(browser, "Unsaved tail.");
        });

        await step(browser, "closing with nothing unsaved just closes", async () => {
            await (await browser.$('button[aria-label="Close"]')).click();
            await browser.pause(1_000);
            assert.equal(await browser.$('[role="alertdialog"]').isExisting().catch(() => false), false);
        });
    } finally {
        await endSession(browser);
    }
}

try {
    await run();
    console.log("Smoke test passed.");
} catch (err) {
    console.log("Smoke test failed.");
    console.error(err);
    process.exitCode = 1;
} finally {
    driver.kill();
}
