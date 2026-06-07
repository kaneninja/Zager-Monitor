// poll-zager.mjs — fetch the Zager feed, diff against your watchlist + previous
// snapshot, write flags, and email a digest. Runs server-side (GitHub Actions or
// any Node host). All secrets come from env; nothing sensitive is hard-coded.
//
// Required env:
//   ZAGER_FEED_URL        full CSV feed URL *including the key* (kept in a secret)
//   SUPABASE_URL          your Supabase project URL
//   SUPABASE_SERVICE_KEY  Supabase service-role key (server-side only — never browser)
// Optional env:
//   DEFAULT_THRESHOLD     low-stock cutoff when a model has no per-row threshold (default 3)
//   RESEND_API_KEY        enables email alerts
//   ALERT_EMAIL_TO        comma-separated recipient(s)
//   ALERT_EMAIL_FROM      sender (default onboarding@resend.dev — fine for self-alerts)
//   ARRIVAL_BRANDS        comma-separated brand filter for new-item alerts (default: all)

import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const FEED_URL = process.env.ZAGER_FEED_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEFAULT_THRESHOLD = parseInt(process.env.DEFAULT_THRESHOLD || "3", 10);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO;
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || "Bubba's Stock Watch <onboarding@resend.dev>";
const ARRIVAL_BRANDS = (process.env.ARRIVAL_BRANDS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean); // empty = all brands

if (!FEED_URL || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing required env (ZAGER_FEED_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY).");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const norm = (s) => String(s ?? "").trim().toUpperCase();
const priceNum = (p) => {
  const n = parseFloat(String(p ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Read every existing model key (paginated — Supabase caps page size at ~1000).
async function fetchExistingModels() {
  const set = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("zager_stock").select("model").range(from, from + PAGE - 1);
    if (error) throw new Error("zager_stock read: " + error.message);
    data.forEach((r) => set.add(r.model));
    if (data.length < PAGE) break;
  }
  return set;
}

async function main() {
  // 1. Fetch the feed (key is in the URL, which lives in a secret)
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();

  // 2. Parse CSV (papaparse handles quoted commas/newlines in descriptions)
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors?.length) {
    console.warn(`CSV parse warnings: ${parsed.errors.slice(0, 3).map((e) => e.message).join("; ")}`);
  }

  const now = new Date().toISOString();
  const feed = new Map();
  const stockRows = [];
  for (const row of parsed.data) {
    const model = norm(row["Item #"]);
    if (!model) continue;
    const qtyRaw = parseInt(row["Stock Qty"], 10);
    const rec = {
      model,
      qty: Number.isFinite(qtyRaw) ? qtyRaw : null,
      name: (row["Item name"] || "").trim(),
      brand: (row["Brand"] || "").trim(),
      collection: (row["Collection"] || "").trim(),
      price: (row["price"] || "").trim(),
      msrp: (row["MSRP"] || "").trim(),
      image: (row["image"] || "").trim(),
    };
    feed.set(model, rec);
    stockRows.push({ ...rec, updated_at: now });
  }
  if (feed.size === 0) throw new Error("Feed parsed to 0 rows — aborting so we don't wipe good data.");
  console.log(`Parsed ${feed.size} items from feed.`);

  // 3.
