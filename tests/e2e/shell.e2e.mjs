// End-to-end test of the Atlas shell against the real core + engine.
// Requires the dev stack (infrastructure/scripts/dev.sh) and tests/e2e/fake_llm.py running.
// Usage: ATLAS_URL="http://127.0.0.1:5173/#token=…" DOCS=/path/to/Documents SHOTS=dir node tests/e2e/shell.e2e.mjs
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const paths = (process.env.ATLAS_NODE_PATH || "").split(":").filter(Boolean);
const { chromium } = require(require.resolve("playwright", { paths }));

const URL = process.env.ATLAS_URL;
const DOCS = process.env.DOCS;
const SHOTS = process.env.SHOTS || "screenshots";
const FAKE_LLM = process.env.FAKE_LLM_URL || "http://127.0.0.1:47899/v1";
mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name]); console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 4).join(" | ")); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

await page.goto(URL);

await step("home renders launcher and greeting", async () => {
  await page.getByRole("heading", { level: 1 }).filter({ hasText: /Good (morning|afternoon|evening)/ }).waitFor();
  assert.equal(await page.locator(".app-tile").count(), 21);
  await page.screenshot({ path: `${SHOTS}/01-home-light.png` });
});

await step("planned apps are honest placeholders", async () => {
  await page.locator(".rail-btn", { hasText: "Writer" }).click();
  await page.getByText("Planned for").waitFor();
  assert.ok(await page.getByText("Milestone 3").isVisible());
});

await step("share a folder in Settings", async () => {
  await page.locator(".rail-btn", { hasText: "Settings" }).click();
  await page.locator(".settings-nav button", { hasText: "Folders" }).click();
  await page.getByPlaceholder("/home/you/Documents").fill(DOCS);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.locator(".grant-list li", { hasText: "Documents" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/02-settings-folders.png` });
});

await step("refuses to share a credential folder", async () => {
  await page.getByPlaceholder("/home/you/Documents").fill("/etc");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.locator(".toast", { hasText: "Could not share that folder" }).waitFor();
});

await step("Drive lists, previews and creates", async () => {
  await page.locator(".rail-btn", { hasText: "Drive" }).click();
  await page.locator(".file-name", { hasText: "plan.md" }).click();
  await page.locator(".preview pre", { hasText: "Q3 plan" }).waitFor();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByPlaceholder("Folder name").fill("drafts");
  await page.getByRole("button", { name: "Create" }).click();
  await page.locator(".file-name", { hasText: "drafts" }).waitFor();
  assert.ok(existsSync(`${DOCS}/drafts`), "folder exists on disk");
  await page.locator(".file-name", { hasText: "reports" }).click();
  await page.locator(".file-name", { hasText: "scores.csv" }).waitFor();
  await page.locator(".crumbs button", { hasText: "Documents" }).click();
  await page.locator(".file-name", { hasText: "plan.md" }).click();
  await page.locator(".preview pre", { hasText: "Q3 plan" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/03-drive.png` });
});

await step("command palette finds files", async () => {
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search", { exact: true }).fill("score");
  await page.locator(".palette-list li", { hasText: "scores.csv" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/04-palette.png` });
  await page.keyboard.press("Escape");
});

await step("AI without provider explains how to connect", async () => {
  await page.locator(".ai-dock .banner", { hasText: "No AI provider yet" }).waitFor();
  await page.getByLabel("Message Atlas AI").fill("hello");
  await page.getByLabel("Message Atlas AI").press("Enter");
  await page.locator(".ai-dock .banner-danger", { hasText: "No AI provider is configured" }).waitFor();
});

await step("Gemini (free) is the default provider choice", async () => {
  await page.locator(".rail-btn", { hasText: "Settings" }).click();
  await page.locator(".settings-nav button", { hasText: "Atlas AI" }).click();
  const active = page.locator(".provider.is-active");
  await active.waitFor();
  assert.match(await active.innerText(), /Gemini/);
  assert.match(await active.innerText(), /Free/);
  await page.screenshot({ path: `${SHOTS}/05-settings-ai.png` });
});

await step("connect a local model server", async () => {
  await page.locator(".provider", { hasText: "Local model" }).click();
  await page.getByLabel("Server URL").fill(FAKE_LLM);
  await page.getByLabel("Model").fill("scripted-test-model");
  await page.getByRole("button", { name: "Save and test" }).click();
  await page.locator(".toast", { hasText: "Atlas AI is ready" }).waitFor();
  await page.locator(".privacy.local", { hasText: "Runs on this computer" }).waitFor({ timeout: 8000 });
});

await step("AI task: live plan, approval card, approve, file trashed", async () => {
  await page.getByLabel("Message Atlas AI").fill("Find my notes file and move it to the trash");
  await page.getByLabel("Message Atlas AI").press("Enter");
  const card = page.locator(".approval", { hasText: "notes.txt" });
  await card.waitFor({ timeout: 15000 });
  assert.ok(existsSync(`${DOCS}/notes.txt`), "nothing deleted before approval");
  await page.locator(".plan li").first().waitFor();
  await page.screenshot({ path: `${SHOTS}/06-ai-approval.png` });
  await card.getByRole("button", { name: "Approve" }).click();
  await page.locator(".status-completed").waitFor({ timeout: 15000 });
  assert.ok(!existsSync(`${DOCS}/notes.txt`), "file moved after approval");
  assert.equal(await page.locator(".plan li.plan-done").count(), 3);
  await page.screenshot({ path: `${SHOTS}/07-ai-done.png` });
});

await step("activity log records the AI action", async () => {
  await page.locator(".settings-nav button", { hasText: "Privacy & activity" }).click();
  await page.locator("tr", { hasText: "fs.trash" }).filter({ hasText: "Atlas AI" }).filter({ hasText: "ok" }).first().waitFor();
});

await step("dark theme", async () => {
  await page.locator(".settings-nav button", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.locator(".rail-btn", { hasText: "Home" }).click();
  await page.screenshot({ path: `${SHOTS}/08-home-dark.png` });
});

await step("no uncaught page errors", async () => { assert.deepEqual(errors, []); });

await browser.close();
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
