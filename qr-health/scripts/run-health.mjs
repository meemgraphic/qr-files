import { runHealth, alertFailure } from "../netlify/lib/health-core.mjs";
try {
  const r = await runHealth(process.env, { test: process.argv.includes("--test") });
  console.log(`Checked ${r.total} QRs (${r.checks} checks) in ${(r.ms / 1000).toFixed(1)}s — ${r.issues.length} issue(s).`);
  r.issues.forEach(i => console.log(` • ${i.name} — ${i.label}: ${i.detail} ${i.url}`));
  if (r.sent) console.log("WhatsApp sent via " + r.sent);
} catch (e) {
  console.error("FAILED:", e.message);
  await alertFailure(e);
  process.exit(1);
}
