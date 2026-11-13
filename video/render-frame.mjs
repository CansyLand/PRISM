// Render one frame of video/style-board.html to an MP4.
//   node video/render-frame.mjs B1 out.mp4 [seconds=6] [fps=30]
// Plays the 3-second opener once, then holds the last frame. Needs puppeteer-core and ffmpeg.
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [key = "B1", out = "out.mp4", secs = "6", fpsArg = "30"] = process.argv.slice(2);
const fps = Number(fpsArg), total = Math.round(Number(secs) * fps), anim = 3 * fps; // the opener is 3 s
const board = process.env.BOARD || path.join(path.dirname(fileURLToPath(import.meta.url)), "style-board.html");
const chrome = process.env.CHROME || fs.readdirSync(path.join(os.homedir(), ".cache/puppeteer/chrome")).map((v) => path.join(os.homedir(), ".cache/puppeteer/chrome", v, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uprise-frames-"));

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto("file://" + board, { waitUntil: "networkidle0" });
await page.evaluate(async (key) => {
  await document.fonts.ready;
  const idx = ["1", "2", "3"].indexOf(key[1]) + 3 * ["A", "B", "C"].indexOf(key[0]);
  const svg = document.querySelectorAll("figure svg")[idx];
  document.body.innerHTML = ""; document.body.style.margin = "0";
  svg.style.cssText = "width:1920px;height:1080px;border-radius:0;display:block"; document.body.appendChild(svg);
}, key);
for (let f = 0; f < total; f++) {
  const t = Math.min(f, anim - 1) / fps * 1000; // after the opener, hold its last frame
  if (f < anim || f === anim) await page.evaluate((t) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t; }), t);
  await page.screenshot({ path: path.join(tmp, `f${String(f).padStart(4, "0")}.png`) });
}
await browser.close();
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(tmp, "f%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart", out]);
fs.rmSync(tmp, { recursive: true });
console.log("wrote", out);
