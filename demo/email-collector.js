#!/usr/bin/env node
/**
 * email-collector.js — append-only, deduped email list.
 *
 *   node email-collector.js add <email> [more@emails ...]   validate + append (dedup)
 *   node email-collector.js list                            show all
 *   node email-collector.js count                           show total
 *   node email-collector.js check <email>                   exists?
 *   node email-collector.js add ... --file <path>           use a different list file
 *
 * List format: one email per line as  <email>  <ISO timestamp>
 * Plain text, human-readable, no secrets.
 */
const fs = require("fs");
const path = require("path");

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function parseArgs(argv) {
  const args = { file: path.join(__dirname, "email_list.txt"), action: "help", emails: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") { args.file = path.resolve(argv[++i]); }
    else if (a === "-h" || a === "--help") { args.action = "help"; }
    else if (["add", "list", "count", "check"].includes(a)) { args.action = a; }
    else { args.emails.push(a); }
  }
  return args;
}

function readList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
}

function emailsOf(lines) {
  return lines.map((l) => l.split(/\s+/)[0].toLowerCase()).filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.action === "help") {
    console.log(__dirname ? "PRISM email collector" : "");
    console.log("Usage:");
    console.log("  node email-collector.js add a@b.com c@d.com   (validate + append, dedup)");
    console.log("  node email-collector.js list");
    console.log("  node email-collector.js count");
    console.log("  node email-collector.js check a@b.com");
    console.log("  ... --file /path/to/email_list.txt");
    return;
  }

  const file = args.file;
  const lines = readList(file);
  const existing = new Set(emailsOf(lines));

  if (args.action === "count") {
    console.log(JSON.stringify({ file, count: existing.size }));
    return;
  }
  if (args.action === "list") {
    const out = existing.size ? Array.from(existing).join("\n") : "(empty)";
    console.log(out);
    return;
  }
  if (args.action === "check") {
    const e = (args.emails[0] || "").toLowerCase();
    const valid = EMAIL_RE.test(e);
    console.log(JSON.stringify({ email: e, valid, exists: valid && existing.has(e) }));
    return;
  }
  if (args.action === "add") {
    const added = [], rejected = [];
    for (const raw of args.emails) {
      const e = raw.trim().toLowerCase();
      if (!e) { rejected.push({ email: raw, reason: "empty" }); continue; }
      if (!EMAIL_RE.test(e)) { rejected.push({ email: raw, reason: "invalid format" }); continue; }
      if (existing.has(e)) { rejected.push({ email: raw, reason: "already listed" }); continue; }
      existing.add(e);
      added.push(e);
    }
    if (added.length) {
      const ts = new Date().toISOString();
      fs.appendFileSync(file, added.map((e) => `${e}\t${ts}`).join("\n") + "\n");
    }
    console.log(JSON.stringify({ file, added, rejected, total: existing.size }, null, 2));
    return;
  }
  console.error("Unknown action. Run with --help.");
  process.exit(1);
}

main();
