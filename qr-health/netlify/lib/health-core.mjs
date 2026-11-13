// QR health check — zero dependencies, Node 18+.
// Signs in as the owner, reads every QR project, checks everything a visitor would touch,
// saves a report to Firestore (shown on the dashboard) and sends a WhatsApp alert on problems.
import zlib from "node:zlib";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = "Mozilla/5.0 (compatible; ClayQRHealth/1.0; +https://clayncode.netlify.app)";

/* ---- same button → link rules as the page viewer ---- */
const u = (v, base) => { v = v.trim(); return /^https?:/.test(v) ? v : base + v.replace(/^@/, ""); };
const P = {
  review: ["Google Review", v => /^https?:/.test(v.trim()) ? v.trim() : "https://search.google.com/local/writereview?placeid=" + encodeURIComponent(v.trim())],
  call: ["Call", v => "tel:" + v.replace(/[^\d+]/g, "")],
  whatsapp: ["WhatsApp", v => "https://wa.me/" + v.replace(/\D/g, "")],
  sms: ["SMS", v => "sms:" + v.replace(/[^\d+]/g, "")],
  email: ["Email", v => "mailto:" + v],
  instagram: ["Instagram", v => u(v, "https://instagram.com/")],
  tiktok: ["TikTok", v => u(v, "https://tiktok.com/@")],
  twitter: ["X / Twitter", v => u(v, "https://x.com/")],
  facebook: ["Facebook", v => u(v, "https://facebook.com/")],
  youtube: ["YouTube", v => u(v, "https://youtube.com/@")],
  linkedin: ["LinkedIn", v => u(v, "https://linkedin.com/company/")],
  snapchat: ["Snapchat", v => u(v, "https://snapchat.com/add/")],
  telegram: ["Telegram", v => u(v, "https://t.me/")],
  website: ["Website", v => /^https?:/.test(v) ? v : "https://" + v],
  maps: ["Location", v => /^https?:/.test(v) ? v : "https://maps.google.com/?q=" + encodeURIComponent(v)],
};

const unb64 = s => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
function decodeStatic(hashData) { // "#p=" payload
  const m = hashData[0], b = unb64(hashData.slice(1));
  return JSON.parse((m === "z" ? zlib.inflateRawSync(b) : b).toString("utf8"));
}

export async function runHealth(env = process.env, opts = {}) {
  const C = {
    project: env.FB_PROJECT || "qr-pages-b511c",
    key: env.FB_KEY || "AIzaSyAbWDAT0pWLZhncX_WcaWGFlD2HdN4tcXs",
    email: env.OWNER_EMAIL || "clayncodebranding@gmail.com",
    pin: env.OWNER_PIN,
    auth: env.AUTH_BASE || "https://identitytoolkit.googleapis.com",
    fs: env.FS_BASE || "https://firestore.googleapis.com",
    timeout: +env.CHECK_TIMEOUT_MS || 15000,
    retryDelay: env.RETRY_DELAY_MS != null ? +env.RETRY_DELAY_MS : 3000,
    tz: env.TZ_NAME || "Asia/Kolkata",
    site: env.SITE_URL || "",
  };
  if (!C.pin) throw new Error("OWNER_PIN is not set");
  const t0 = Date.now();
  const docBase = `${C.fs}/v1/projects/${C.project}/databases/(default)/documents`;

  /* ---- Firebase helpers ---- */
  const sv = f => (f && (f.stringValue ?? f.integerValue)) ?? "";
  async function signIn() {
    const r = await fetch(`${C.auth}/v1/accounts:signInWithPassword?key=${C.key}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: C.email, password: C.pin, returnSecureToken: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Owner sign-in failed: " + (j.error?.message || r.status) + " (check OWNER_PIN)");
    return { token: j.idToken, uid: j.localId };
  }
  const authH = tok => ({ authorization: "Bearer " + tok });
  async function listDocs(path, tok) {
    let out = [], pt = "";
    do {
      const r = await fetch(`${docBase}/${path}?pageSize=300${pt ? "&pageToken=" + pt : ""}`, { headers: authH(tok) });
      if (!r.ok) throw new Error(`Couldn't read ${path}: HTTP ${r.status}`);
      const j = await r.json(); out = out.concat(j.documents || []); pt = j.nextPageToken || "";
    } while (pt);
    return out;
  }
  async function getDoc(path, tok) {
    const r = await fetch(`${docBase}/${path}${tok ? "" : "?key=" + C.key}`, { headers: tok ? authH(tok) : {} });
    if (r.status === 404) return { missing: true };
    if (!r.ok) return { error: "HTTP " + r.status };
    return { doc: await r.json() };
  }
  async function putDoc(path, fields, tok) {
    const r = await fetch(`${docBase}/${path}`, { method: "PATCH", headers: { ...authH(tok), "content-type": "application/json" }, body: JSON.stringify({ fields }) });
    if (!r.ok) throw new Error(`Couldn't save ${path}: HTTP ${r.status} — publish the new Firestore rules (health section).`);
  }

  /* ---- HTTP checks (cached per URL for this run) ---- */
  const cache = new Map();
  function check(url, wantApp) {
    const k = url + "|" + !!wantApp;
    if (!cache.has(k)) cache.set(k, doCheck(url, wantApp));
    return cache.get(k);
  }
  async function doCheck(url, wantApp) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const last = attempt === 2;
      try {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), C.timeout);
        const res = await fetch(url, { redirect: "follow", signal: ac.signal, headers: { "user-agent": UA, accept: "text/html,*/*" } });
        const s = res.status;
        let body = "";
        if (wantApp && s < 400) body = await res.text(); else { try { await res.body?.cancel(); } catch {} }
        clearTimeout(t);
        if (s < 400) {
          if (wantApp && !body.includes('id="viewer"')) return { ok: false, detail: "opens, but it's not the QR page (wrong file?)" };
          return { ok: true, status: s };
        }
        if ([401, 403, 405, 406, 429, 451, 999].includes(s)) return { ok: true, status: s, note: "site blocks automated checks" };
        if (s === 404 || s === 410) return { ok: false, detail: `HTTP ${s} — page not found` };
        if (s >= 500 && !last) { await sleep(C.retryDelay); continue; }
        return { ok: false, detail: s >= 500 ? `server error (HTTP ${s})` : `HTTP ${s}` };
      } catch (e) {
        if (!last) { await sleep(C.retryDelay); continue; }
        return { ok: false, detail: e.name === "AbortError" ? `no answer after ${Math.round(C.timeout / 1000)}s` : "can't connect (" + (e.cause?.code || e.message) + ")" };
      }
    }
  }
  async function pool(tasks, n) {
    const q = [...tasks], run = async () => { while (q.length) await q.shift()(); };
    await Promise.all(Array.from({ length: n }, run));
  }

  /* ---- load everything ---- */
  const { token, uid } = await signIn();
  const prevDoc = await getDoc(`users/${uid}/health/latest`, token);
  let prev = null; try { prev = prevDoc.doc ? JSON.parse(sv(prevDoc.doc.fields.json)) : null; } catch {}
  const recs = (await listDocs(`users/${uid}/projects`, token)).map(d => { try { return JSON.parse(sv(d.fields.json)); } catch { return null; } }).filter(Boolean);

  const issues = [];
  const add = (ids, kind, label, url, detail) => issues.push({ ids: [].concat(ids), kind, label, url: url || "", detail });
  let checks = 0;
  const tasks = [];
  const hostIds = new Map(); // host -> record ids

  for (const r of recs) {
    const host = (r.host || (r.url || "").split("#")[0] || "").split("#")[0];
    if (host) { if (!hostIds.has(host)) hostIds.set(host, []); hostIds.get(host).push(r.id); }
    tasks.push(async () => {
      let d = null;
      if (r.pid) {
        checks++;
        const g = await getDoc(`pages/${r.pid}`);
        if (g.missing) { add(r.id, "page", "QR page deleted", "", "The page behind this QR no longer exists — scans show “no longer available”."); return; }
        if (g.error) { add(r.id, "page", "Page can't be read", "", g.error); return; }
        try { d = JSON.parse(sv(g.doc.fields.d)); } catch { add(r.id, "page", "Page data is damaged", "", "The saved page can't be read."); return; }
      } else if ((r.url || "").includes("#p=")) {
        try { d = decodeStatic(r.url.split("#p=")[1]); } catch { add(r.id, "page", "QR link is damaged", "", "The QR's link can't be decoded."); return; }
      } else { return; }

      const targets = [];
      if (d.r) targets.push(["Link", d.r]);
      for (const [k, v] of d.k || []) { if (P[k] && v) { try { targets.push([P[k][0], P[k][1](v)]); } catch {} } }
      for (const [label, url] of targets) {
        if (/^tel:|^sms:/.test(url)) { checks++; if (url.replace(/\D/g, "").length < 7) add(r.id, "link", label, url, "phone number looks too short"); continue; }
        if (/^mailto:/.test(url)) { checks++; if (!/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url)) add(r.id, "link", label, url, "email address looks wrong"); continue; }
        if (/^https:\/\/wa\.me\//.test(url)) { checks++; if (url.replace(/\D/g, "").length < 8) add(r.id, "link", label, url, "WhatsApp number looks too short"); continue; }
        if (!/^https?:\/\//i.test(url)) continue;
        checks++;
        const res = await check(url);
        if (!res.ok) add(r.id, "link", label, url, res.detail);
      }
      if (d.li) {
        checks++;
        const g = await getDoc(`logos/${d.li}`);
        if (g.missing || g.error || !/^data:image\//.test(sv(g.doc?.fields?.d))) {
          if (d.l && host) { const res = await check(new URL(d.l, host).href); if (!res.ok) add(r.id, "logo", "Logo", "", "the logo is missing — the page shows a letter instead"); }
          else add(r.id, "logo", "Logo", "", "the hosted logo is missing — the page shows a letter instead");
        }
      } else if (d.l && !/^data:/.test(d.l)) {
        checks++;
        try { const res = await check(/^https?:/.test(d.l) ? d.l : new URL(d.l, host + "/").href); if (!res.ok) add(r.id, "logo", "Logo", d.l, res.detail); } catch {}
      }
    });
  }
  for (const [host, ids] of hostIds) {
    tasks.unshift(async () => {
      checks++;
      const res = await check(host, true);
      if (!res.ok) add(ids, "host", "QR page address is down", host, res.detail);
    });
  }
  await pool(tasks, 8);

  /* ---- report ---- */
  const results = {};
  recs.forEach(r => results[r.id] = { ok: true, n: 0 });
  issues.forEach(i => i.ids.forEach(id => { if (results[id]) { results[id].ok = false; results[id].n++; } }));
  const names = Object.fromEntries(recs.map(r => [r.id, r.name || "Untitled"]));
  issues.forEach(i => i.name = i.ids.length > 1 ? `${i.ids.length} QRs` : names[i.ids[0]] || "");
  const report = {
    ts: Date.now(), ms: Date.now() - t0, source: "server", total: recs.length, checks,
    okCount: Object.values(results).filter(x => x.ok).length, issues, results,
  };
  const day = new Date().toLocaleDateString("en-CA", { timeZone: C.tz });
  const fields = { json: { stringValue: JSON.stringify(report) }, ts: { integerValue: String(report.ts) } };
  await putDoc(`users/${uid}/health/latest`, fields, token);
  await putDoc(`users/${uid}/health/d_${day}`, fields, token);

  /* ---- WhatsApp ---- */
  let sent = null;
  const site = C.site || [...hostIds.keys()][0] || "";
  const text = buildMessage(report, prev, site, !!opts.test || env.WA_TEST === "1");
  if (text) sent = await sendWhatsApp(text, env);
  return { ...report, sent, text };
}

function buildMessage(rep, prev, site, test) {
  const n = rep.issues.length, date = new Date(rep.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  if (n > 0) {
    const lines = rep.issues.slice(0, 8).map((i, k) => `${k + 1}) ${i.name} — ${i.label}: ${i.detail}${i.url ? "\n   " + i.url : ""}`);
    return `⚠️ QR health ${date}: ${n} issue${n > 1 ? "s" : ""} in ${rep.total} QRs\n\n${lines.join("\n")}${n > 8 ? `\n…and ${n - 8} more` : ""}${site ? `\n\nDashboard: ${site}` : ""}`;
  }
  if (prev && prev.issues && prev.issues.length) return `✅ QR health ${date}: all ${rep.total} QRs are working again.`;
  if (test) return `✅ QR health test ${date}: ${rep.total} QRs checked, no problems. WhatsApp alerts are working.`;
  return null;
}

async function sendWhatsApp(text, env) {
  const phone = (env.WA_PHONE || "").replace(/\D/g, "");
  if (!phone) throw new Error("WA_PHONE is not set (your number with country code, e.g. 919876543210)");
  if (env.CALLMEBOT_KEY) {
    const base = env.CALLMEBOT_URL || "https://api.callmebot.com/whatsapp.php";
    const r = await fetch(`${base}?phone=%2B${phone}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(env.CALLMEBOT_KEY)}`);
    if (!r.ok) throw new Error("CallMeBot said HTTP " + r.status + ": " + (await r.text()).slice(0, 160));
    return "callmebot";
  }
  if (env.TWILIO_SID && env.TWILIO_TOKEN) {
    const from = env.TWILIO_FROM || "+14155238886";
    const base = env.TWILIO_URL || "https://api.twilio.com";
    const r = await fetch(`${base}/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(env.TWILIO_SID + ":" + env.TWILIO_TOKEN).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: "whatsapp:+" + phone, From: "whatsapp:" + from.replace(/^whatsapp:/, ""), Body: text }),
    });
    if (!r.ok) throw new Error("Twilio said HTTP " + r.status + ": " + (await r.text()).slice(0, 160));
    return "twilio";
  }
  throw new Error("No WhatsApp provider set. Add CALLMEBOT_KEY (or TWILIO_SID + TWILIO_TOKEN).");
}

/* If the checker itself breaks, tell the owner instead of failing silently. */
export async function alertFailure(err, env = process.env) {
  try { await sendWhatsApp("🔴 QR health check could not run: " + String(err.message || err).slice(0, 300), env); } catch {}
}
