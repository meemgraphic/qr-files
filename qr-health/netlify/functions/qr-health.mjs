// OPTIONAL: run the daily check as a Netlify Scheduled Function instead of GitHub Actions.
// Note: Netlify scheduled functions stop after 30 seconds, so GitHub Actions is safer for many QRs.
import { runHealth, alertFailure } from "../lib/health-core.mjs";
export default async () => {
  try {
    const r = await runHealth({ ...process.env, CHECK_TIMEOUT_MS: process.env.CHECK_TIMEOUT_MS || "7000", RETRY_DELAY_MS: process.env.RETRY_DELAY_MS || "1000" });
    return new Response(JSON.stringify({ checked: r.total, issues: r.issues.length }), { headers: { "content-type": "application/json" } });
  } catch (e) { await alertFailure(e); return new Response("failed: " + e.message, { status: 500 }); }
};
export const config = { schedule: "30 3 * * *" }; // 03:30 UTC = 09:00 India time
