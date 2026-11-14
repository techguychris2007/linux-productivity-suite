// End-to-end test of the Atlas shell against the real core + engine.
// Requires the dev stack (infrastructure/scripts/dev.sh) and tests/e2e/fake_llm.py running.
// Usage: ATLAS_URL="http://127.0.0.1:5173/#token=…" DOCS=/path/to/Documents SHOTS=dir node tests/e2e/shell.e2e.mjs
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const paths = (process.env.ATLAS_NODE_PATH || "").split(":").filter(Boolean);
const { chromium } = require(require.resolve("playwright", { paths }));
const JSZip = require(require.resolve("jszip", { paths }));

const URL = process.env.ATLAS_URL;
const DOCS = process.env.DOCS;
const SHOTS = process.env.SHOTS || "screenshots";
const FAKE_LLM = process.env.FAKE_LLM_URL || "http://127.0.0.1:47899/v1";
mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name]); console.log("FAIL", name, "\n   ", e.message.split("\n").slice(0, 12).join(" | ")); }
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
  await page.locator(".rail-btn", { hasText: "Sheets" }).click();
  await page.getByText("Planned for").waitFor();
  assert.ok(await page.getByText("Milestone 4").isVisible());
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


await step("Writer: create, type, format, autosave to disk", async () => {
  await page.locator(".rail-btn", { hasText: "Writer" }).click();
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByLabel("Name").fill("Meeting notes");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator(".wb-title", { hasText: "Meeting notes" }).waitFor();
  await page.locator(".wb-paragraph").first().click();
  await page.keyboard.type("Agenda");
  await page.getByLabel("Paragraph style").selectOption("heading1");
  await page.locator(".wb-heading1").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Budget is ");
  await page.keyboard.press("Control+b"); await page.keyboard.type("approved"); await page.keyboard.press("Control+b");
  await page.keyboard.type(".");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Bulleted list" }).click();
  await page.keyboard.type("First item"); await page.keyboard.press("Enter"); await page.keyboard.type("Second item");
  await page.locator(".w-save-saved").waitFor({ timeout: 8000 });
  const saved = JSON.parse(readFileSync(`${DOCS}/Meeting notes.atlasdoc`, "utf8"));
  const types = saved.blocks.map((b) => b.type);
  assert.deepEqual(types, ["title", "heading1", "paragraph", "bullet", "bullet"]);
  assert.equal(saved.blocks[1].html, "Agenda");
  assert.equal(await page.locator(".wb-heading1").innerText(), "Agenda");
  assert.match(saved.blocks[2].html, /<b>approved<\/b>/);
  assert.equal(saved.blocks[4].html, "Second item");
  await page.screenshot({ path: `${SHOTS}/09-writer.png` });
});

await step("Writer: export DOCX (real Word headings) and PDF", async () => {
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: /Word document/ }).click();
  await page.locator(".toast", { hasText: "Exported Meeting notes.docx" }).waitFor({ timeout: 30000 });
  const zip = await JSZip.loadAsync(readFileSync(`${DOCS}/Meeting notes.docx`));
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /w:val="Heading1"/); assert.match(xml, /approved/);
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: /PDF/ }).click();
  await page.locator(".toast", { hasText: "Exported Meeting notes.pdf" }).waitFor({ timeout: 30000 });
  assert.equal(readFileSync(`${DOCS}/Meeting notes.pdf`).subarray(0, 5).toString(), "%PDF-");
});

await step("Writer: Atlas AI edits the open document and it updates live", async () => {
  await page.getByLabel("Message Atlas AI").fill("Add a conclusion to this document");
  await page.getByLabel("Message Atlas AI").press("Enter");
  await page.locator(".ai-dock .goal", { hasText: "Add a conclusion" }).waitFor();
  await page.locator(".wb", { hasText: "Writing in Atlas is fast and private." }).waitFor({ timeout: 20000 });
  await page.locator(".ai-flash").first().waitFor();
  await page.screenshot({ path: `${SHOTS}/10-writer-ai-live.png` });
  await page.locator(".ai-dock .status-completed").waitFor({ timeout: 15000 });
  const saved = JSON.parse(readFileSync(`${DOCS}/Meeting notes.atlasdoc`, "utf8"));
  assert.equal(saved.blocks.at(-2).type, "heading1"); assert.match(saved.blocks.at(-2).html, /Conclusion/);
});

await step("Writer: import a real Word file", async () => {
  await page.getByRole("button", { name: "Back to documents" }).click();
  await page.locator(".import-list li", { hasText: "Old proposal.docx" }).getByRole("button", { name: "Open in Writer" }).click();
  await page.locator(".wb-heading1", { hasText: "Proposal" }).waitFor({ timeout: 30000 });
  await page.locator(".wb-paragraph b", { hasText: "private" }).waitFor();
  assert.equal(await page.locator(".wb-bullet").count(), 2);
});

await step("Atlas AI writes a report and exports it to Word", async () => {
  await page.getByLabel("Message Atlas AI").fill("Write a short project report");
  await page.getByLabel("Message Atlas AI").press("Enter");
  await page.locator(".ai-dock .goal", { hasText: "Write a short project report" }).waitFor();
  await page.locator(".ai-dock .status-completed").waitFor({ timeout: 30000 });
  assert.ok(existsSync(`${DOCS}/Project report.atlasdoc`) && existsSync(`${DOCS}/Project report.docx`));
  await page.getByRole("button", { name: "Back to documents" }).click();
  await page.locator(".doc-card", { hasText: "Project report" }).click();
  await page.locator(".w-table td", { hasText: "Sheets" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/11-writer-ai-report.png` });
});

await step("dark theme", async () => {
  await page.locator(".rail-btn", { hasText: "Settings" }).click();
  await page.locator(".settings-nav button", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.locator(".rail-btn", { hasText: "Home" }).click();
  await page.screenshot({ path: `${SHOTS}/08-home-dark.png` });
  await page.locator(".rail-btn", { hasText: "Writer" }).click();
  await page.getByRole("button", { name: "Back to documents" }).click();
  await page.locator(".doc-card", { hasText: "Meeting notes" }).click();
  await page.locator(".wb-title").waitFor();
  await page.screenshot({ path: `${SHOTS}/12-writer-dark.png` });
});

await step("no uncaught page errors", async () => { assert.deepEqual(errors, []); });

await browser.close();
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
