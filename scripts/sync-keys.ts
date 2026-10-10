import fs from "node:fs";
import path from "node:path";

/**
 * Copies KEY=VALUE lines from the shared keys file (default D:\Vaani Project\API_KEYS.txt, outside the git repo)
 * into aangan-studio/.env.local, which is the only place the app reads secrets from.
 *   npm run keys:sync            (override the source with KEYS_FILE=...)
 * Values are never printed. Lines that are blank, comments, or still contain the placeholder text are skipped.
 */
const src = process.env.KEYS_FILE ?? path.resolve(process.cwd(), "..", "API_KEYS.txt");
const dst = path.resolve(process.cwd(), ".env.local");

if (!fs.existsSync(src)) {
  console.error(`Keys file not found: ${src}`);
  process.exit(1);
}

const keys = new Map<string, string>();
for (const raw of fs.readFileSync(src, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#") || line.startsWith("//")) continue;
  const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  let value = m[2]!.trim();
  if (value.length >= 2 && /^["']/.test(value) && value.at(-1) === value[0]) value = value.slice(1, -1);
  if (!value || /^(PASTE|YOUR|CHANGE|xxx|<)/i.test(value)) continue;
  keys.set(m[1]!, value);
}

const existing = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : "";
const kept = existing.split(/\r?\n/).filter((l) => {
  const k = /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1];
  return !(k && keys.has(k));
});
const out = [...kept.filter((l, i, a) => !(l === "" && a[i - 1] === "")), ...[...keys].map(([k, v]) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`)].join("\n").trim() + "\n";
fs.writeFileSync(dst, out, { mode: 0o600 });
console.log(`Synced ${keys.size} key(s) into .env.local: ${[...keys.keys()].join(", ") || "(none - fill in API_KEYS.txt first)"}`);
