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

  // 3. NEW ITEMS: compare feed against everything seen before (must read BEFORE upsert)
  const existing = await fetchExistingModels();
  const isBaseline = existing.size === 0; // first ever run — don't flag 1,600 "new"
  let arrivals = [];
  if (!isBaseline) {
    arrivals = [...feed.values()].filter((r) => !existing.has(r.model));
    if (ARRIVAL_BRANDS.length) {
      arrivals = arrivals.filter((r) => ARRIVAL_BRANDS.includes(r.brand.toLowerCase()));
    }
  } else {
    console.log("Baseline run — recording catalog, not flagging new arrivals.");
  }

  // 4. Upsert the full snapshot (chunked) — powers catalog lookups + future diffs
  for (let i = 0; i < stockRows.length; i += 500) {
    const { error } = await db.from("zager_stock").upsert(stockRows.slice(i, i + 500), { onConflict: "model" });
    if (error) throw new Error("zager_stock upsert: " + error.message);
  }

  // 4b. Log new arrivals
  if (arrivals.length) {
    const rows = arrivals.map((r) => ({
      model: r.model, name: r.name, brand: r.brand, collection: r.collection,
      qty: r.qty, price: r.price, image: r.image, first_seen: now,
    }));
    const { error } = await db.from("new_arrivals").upsert(rows, { onConflict: "model", ignoreDuplicates: true });
    if (error) console.error("new_arrivals insert:", error.message);
  }

  // 5. Load your watchlist + previous status/price
  const { data: watch, error: wErr } = await db.from("watch_models").select("model, threshold");
  if (wErr) throw new Error("watch_models read: " + wErr.message);
  const { data: prev } = await db.from("watch_status").select("model, status, price");
  const prevMap = new Map((prev || []).map((r) => [norm(r.model), { status: r.status, price: r.price }]));

  // 6. Evaluate each watched model: status + price
  const statusRows = [];
  const statusEvents = [];
  const priceEvents = [];
  let flagged = 0;
  for (const w of watch || []) {
    const m = norm(w.model);
    const hit = feed.get(m);
    const t = w.threshold ?? DEFAULT_THRESHOLD;

    let status = "ok", qty = null, name = "", price = "", image = "";
    if (!hit) {
      status = "gone";
    } else {
      ({ qty, name, price, image } = hit);
      if (qty === null) status = "unknown";
      else if (qty <= 0) status = "out";
      else if (qty <= t) status = "low";
      else status = "ok";
    }
    if (["gone", "out", "low"].includes(status)) flagged++;
    statusRows.push({ model: w.model, status, qty, name, price, image, checked_at: now });

    const before = prevMap.get(m);
    if (before && before.status !== status) {
      statusEvents.push({ model: w.model, old_status: before.status, new_status: status, qty, at: now });
    } else if (!before) {
      statusEvents.push({ model: w.model, old_status: null, new_status: status, qty, at: now });
    }
    // price change (only when we have a real before-price and the item is present)
    if (before && hit) {
      const a = priceNum(before.price), b = priceNum(price);
      if (a !== null && b !== null && Math.abs(a - b) >= 0.01) {
        priceEvents.push({ model: w.model, old_price: before.price, new_price: price, at: now, _name: name, _a: a, _b: b });
      }
    }
  }

  // 7. Persist
  if (statusRows.length) {
    const { error } = await db.from("watch_status").upsert(statusRows, { onConflict: "model" });
    if (error) throw new Error("watch_status upsert: " + error.message);
  }
  if (statusEvents.length) await db.from("stock_events").insert(statusEvents).then(({ error }) => error && console.error("stock_events:", error.message));
  if (priceEvents.length) {
    const clean = priceEvents.map(({ model, old_price, new_price, at }) => ({ model, old_price, new_price, at }));
    await db.from("price_events").insert(clean).then(({ error }) => error && console.error("price_events:", error.message));
  }

  console.log(`Watching ${watch?.length || 0} · ${flagged} flagged · ${statusEvents.filter(e=>e.old_status).length} status changes · ${priceEvents.length} price changes · ${arrivals.length} new arrivals.`);

  // 8. Email digest
  await maybeSendEmail(statusEvents, priceEvents, arrivals);
}

const STATUS_TEXT = { gone: "GONE (off feed)", out: "OUT of stock", low: "LOW", ok: "back OK" };

async function maybeSendEmail(statusEvents, priceEvents, arrivals) {
  if (!RESEND_API_KEY || !ALERT_EMAIL_TO) return;

  const urgent = statusEvents.filter((e) => e.old_status && ["gone", "out", "low"].includes(e.new_status));
  const recovered = statusEvents.filter((e) => e.new_status === "ok" && ["gone", "out", "low"].includes(e.old_status));
  if (!urgent.length && !recovered.length && !priceEvents.length && !arrivals.length) return;

  const nGone = urgent.filter((e) => e.new_status === "gone").length;
  const nOut = urgent.filter((e) => e.new_status === "out").length;
  const nLow = urgent.filter((e) => e.new_status === "low").length;
  const parts = [];
  if (nGone) parts.push(`${nGone} GONE`);
  if (nOut) parts.push(`${nOut} OUT`);
  if (nLow) parts.push(`${nLow} LOW`);
  if (priceEvents.length) parts.push(`${priceEvents.length} price`);
  if (arrivals.length) parts.push(`${arrivals.length} new`);
  if (recovered.length && !parts.length) parts.push(`${recovered.length} back`);
  const icon = urgent.length ? "⚠️" : arrivals.length ? "🆕" : "✓";
  const subject = `${icon} Zager: ${parts.join(" · ")}`;

  const td = "padding:6px 10px;";
  const statusTable = (list) => `<table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:4px;">
    <tr style="background:#eef3f9;text-align:left;"><th style="${td}">Model</th><th style="${td}">Status</th><th style="${td}text-align:center;">Qty</th></tr>
    ${list.map((e) => `<tr><td style="${td}font-family:monospace;font-weight:600;">${e.model}</td><td style="${td}">${STATUS_TEXT[e.new_status] || e.new_status}</td><td style="${td}text-align:center;">${e.qty ?? "—"}</td></tr>`).join("")}
  </table>`;
  const priceTable = (list) => `<table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:4px;">
    <tr style="background:#eef3f9;text-align:left;"><th style="${td}">Model</th><th style="${td}">Was</th><th style="${td}">Now</th></tr>
    ${list.map((e) => { const up = e._b > e._a; return `<tr><td style="${td}font-family:monospace;font-weight:600;">${e.model}</td><td style="${td}color:#8194a8;">$${e.old_price}</td><td style="${td}color:${up ? "#E5484D" : "#30A46C"};font-weight:600;">$${e.new_price} ${up ? "▲" : "▼"}</td></tr>`; }).join("")}
  </table>`;
  const arrivalTable = (list) => { const show = list.slice(0, 25); return `<table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:4px;">
    <tr style="background:#eef3f9;text-align:left;"><th style="${td}">Model</th><th style="${td}">Name</th><th style="${td}text-align:center;">Qty</th><th style="${td}text-align:right;">Price</th></tr>
    ${show.map((r) => `<tr><td style="${td}font-family:monospace;font-weight:600;">${r.model}</td><td style="${td}">${r.name} <span style="color:#8194a8;">· ${r.brand}</span></td><td style="${td}text-align:center;">${r.qty ?? "—"}</td><td style="${td}text-align:right;">${r.price ? "$" + r.price : "—"}</td></tr>`).join("")}
  </table>${list.length > 25 ? `<p style="color:#8194a8;font-size:12px;">+ ${list.length - 25} more</p>` : ""}`; };

  const block = (title, color, inner) => inner ? `<h3 style="margin:18px 0 4px;color:${color};font-size:15px;">${title}</h3>${inner}` : "";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#042C53;">
      <div style="background:#042C53;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;">
        <strong style="font-size:18px;">Zager Stock Watch</strong>
        <div style="color:#aecdf0;font-size:13px;">Bubba's Collective · ${new Date().toUTCString()}</div>
      </div>
      <div style="border:1px solid #dce6f2;border-top:none;padding:16px 20px;border-radius:0 0 10px 10px;">
        ${block("Needs attention", "#E5484D", urgent.length ? statusTable(urgent) : "")}
        ${block("Price changes (your listings)", "#0C447C", priceEvents.length ? priceTable(priceEvents) : "")}
        ${block("New at Zager", "#185FA5", arrivals.length ? arrivalTable(arrivals) : "")}
        ${block("Back in stock", "#30A46C", recovered.length ? statusTable(recovered) : "")}
        <p style="color:#8194a8;font-size:12px;margin-top:18px;">
          GONE = dropped off the feed (likely discontinued). You're only emailed when something changes.
        </p>
      </div>
    </div>`;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: ALERT_EMAIL_FROM,
        to: ALERT_EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
        subject, html,
      }),
    });
    if (!resp.ok) console.error("Email send failed:", resp.status, await resp.text());
    else console.log(`Alert email sent: ${subject}`);
  } catch (e) {
    console.error("Email send error (non-fatal):", e.message);
  }
}

main().catch((e) => {
  console.error("Poll failed:", e.message);
  process.exit(1);
});
