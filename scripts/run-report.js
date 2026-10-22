#!/usr/bin/env node
// Summarizes data/run-log.ndjson for the scheduled (non-backfill) digest
// runs: date coverage, errors, item counts, token/cost totals, and a
// per-source fetched breakdown. Run with: node scripts/run-report.js
//
// No dependencies beyond Node's standard library.

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'data', 'run-log.ndjson');
const MADRID_TZ = 'Europe/Madrid';

function dayKey(iso) {
  // "YYYY-MM-DD" in Europe/Madrid, matching the workflow's own day-boundary
  // logic (the intro line, the Telegram throttle) — not the UTC day the
  // timestamp happens to be written in.
  return new Intl.DateTimeFormat('en-CA', { timeZone: MADRID_TZ }).format(new Date(iso));
}

function dayKeyToDate(key) {
  // For day-count arithmetic only — treated as plain calendar-day labels,
  // not real instants, so the UTC-vs-Madrid distinction doesn't matter here.
  return new Date(`${key}T00:00:00Z`);
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function loadEntries() {
  let raw;
  try {
    raw = fs.readFileSync(LOG_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: null, malformed: 0 };
    throw e;
  }

  const entries = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (e) {
      malformed++;
    }
  }
  return { entries, malformed };
}

function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

function formatMoney(n) {
  return `$${Number(n).toFixed(4)}`;
}

function main() {
  const { entries, malformed } = loadEntries();

  if (entries === null) {
    console.log(`No run log found at ${path.relative(process.cwd(), LOG_PATH)} — the pipeline hasn't run yet.`);
    return;
  }

  if (malformed > 0) {
    console.error(`Warning: skipped ${malformed} unparseable line(s) in the run log.`);
  }

  const runs = entries.filter((e) => e.mode !== 'backfill');

  if (!runs.length) {
    console.log('No scheduled (non-backfill) runs found in the run log.');
    return;
  }

  // --- Date coverage ---
  const dayKeys = runs.map((r) => dayKey(r.timestamp)).sort();
  const firstDay = dayKeys[0];
  const lastDay = dayKeys[dayKeys.length - 1];
  const daysWithRun = new Set(dayKeys);

  const rangeDays = Math.round((dayKeyToDate(lastDay) - dayKeyToDate(firstDay)) / 86400000) + 1;

  const missingDays = [];
  let cursor = dayKeyToDate(firstDay);
  const end = dayKeyToDate(lastDay);
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    if (!daysWithRun.has(key)) missingDays.push(key);
    cursor = addDays(cursor, 1);
  }

  // --- Errors ---
  const runsWithError = runs.filter((r) => (r.errors || []).length > 0).length;
  const sourceErrorCounts = {}; // name -> count of runs where that source had a fetch error
  for (const r of runs) {
    for (const s of r.sources || []) {
      if (s.error) sourceErrorCounts[s.name] = (sourceErrorCounts[s.name] || 0) + 1;
    }
  }

  // --- Item counts ---
  // "sent" was only added once digest caps shipped — older entries only
  // have "kept" (everything that passed the threshold, pre-cap). Fall
  // back to kept so older log lines still contribute to the totals.
  let totalFetched = 0;
  let totalScored = 0;
  let totalSent = 0;
  for (const r of runs) {
    totalFetched += r.fetched || 0;
    totalScored += r.scored || 0;
    totalSent += r.sent !== undefined ? r.sent : (r.kept || 0);
  }
  const avgSentPerRun = totalSent / runs.length;

  // --- Tokens and cost ---
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  for (const r of runs) {
    totalInputTokens += r.input_tokens || 0;
    totalOutputTokens += r.output_tokens || 0;
    totalCost += r.estimated_cost_usd || 0;
  }
  const avgCostPerRun = totalCost / runs.length;

  // --- Per-source fetched totals ---
  // Only "fetched" (and errors, above) are recorded per source for a
  // scheduled run — scored/sent are only tracked in aggregate per run, not
  // broken out per source, so they can't be reported here without
  // changing what the workflow logs.
  const perSourceFetched = {}; // name -> total fetched across all runs
  const sourceNamesSeen = new Set();
  for (const r of runs) {
    for (const s of r.sources || []) {
      sourceNamesSeen.add(s.name);
      perSourceFetched[s.name] = (perSourceFetched[s.name] || 0) + (s.fetched || 0);
    }
  }
  const entriesMissingSources = runs.filter((r) => !r.sources).length;

  // --- Print ---
  console.log('=== Music News Digest — run report ===');
  console.log(`(scheduled runs only — ${entries.length - runs.length} backfill entr${entries.length - runs.length === 1 ? 'y' : 'ies'} ignored)\n`);

  console.log('-- Date coverage (Europe/Madrid calendar days) --');
  console.log(`First run: ${firstDay}`);
  console.log(`Last run:  ${lastDay}`);
  console.log(`Calendar days in range: ${rangeDays}`);
  console.log(`Days with a completed run: ${daysWithRun.size}`);
  if (missingDays.length) {
    console.log(`Days with no run (${missingDays.length}): ${missingDays.join(', ')}`);
  } else {
    console.log('Days with no run: none');
  }

  console.log('\n-- Runs and errors --');
  console.log(`Total runs: ${runs.length}`);
  console.log(`Runs with at least one error: ${runsWithError}`);
  const sourceErrorNames = Object.keys(sourceErrorCounts);
  if (sourceErrorNames.length) {
    console.log('Source-level fetch errors (runs affected, per source):');
    for (const name of sourceErrorNames.sort()) {
      console.log(`  ${name}: ${sourceErrorCounts[name]}`);
    }
  } else {
    console.log('Source-level fetch errors: none');
  }

  console.log('\n-- Items --');
  console.log(`Total fetched: ${formatNumber(totalFetched)}`);
  console.log(`Total scored: ${formatNumber(totalScored)}`);
  console.log(`Total sent: ${formatNumber(totalSent)}`);
  console.log(`Average sent per run: ${avgSentPerRun.toFixed(2)}`);

  console.log('\n-- Tokens and cost --');
  console.log(`Total input tokens: ${formatNumber(totalInputTokens)}`);
  console.log(`Total output tokens: ${formatNumber(totalOutputTokens)}`);
  console.log(`Total estimated cost: ${formatMoney(totalCost)}`);
  console.log(`Average cost per run: ${formatMoney(avgCostPerRun)}`);

  console.log('\n-- Per-source totals (fetched only — see note) --');
  if (sourceNamesSeen.size) {
    for (const name of [...sourceNamesSeen].sort()) {
      console.log(`  ${name}: fetched ${formatNumber(perSourceFetched[name])}`);
    }
  } else {
    console.log('  No per-source breakdown available (older log entries predate it).');
  }
  console.log(
    '  Note: scheduled runs only log fetched/error per source, not scored or sent — ' +
      'those are only tracked in aggregate per run (see "Items" above). Per-source ' +
      'scored/sent would require changing what the workflow logs.'
  );
  if (entriesMissingSources > 0) {
    console.log(`  ${entriesMissingSources} run(s) predate per-source logging entirely and aren't included in the per-source totals above.`);
  }
}

main();
