/**
 * fetch-jira-data.js  (v2)
 * Place this file at: scripts/fetch-jira-data.js in the GitHub repo.
 *
 * Pulls live delivery metrics from Jira and writes data.json for the
 * Delivery Dashboard (index.html) to read.
 *
 * Run by .github/workflows/update-dashboard-data.yml on a schedule.
 *
 * Env vars required (set as GitHub Actions secrets):
 *   JIRA_BASE_URL   e.g. https://apspayroll.atlassian.net
 *   JIRA_EMAIL      the Jira account email tied to the API token
 *   JIRA_API_TOKEN  Jira Cloud API token (id.atlassian.com/manage-profile/security/api-tokens)
 *
 * WHAT'S NEW IN V2:
 *   - Rolling 8-week (56-day) window, always relative to "today" (the
 *     day the script runs), instead of a fixed 30-day window.
 *   - Lead Time (created -> resolved) alongside Cycle Time
 *     (first "In Progress" transition -> resolved).
 *   - A `weekly` array per project: 8 buckets (oldest -> newest) with
 *     throughput, cycle time, lead time, quality, and AI-leverage for
 *     that specific week, so the dashboard can show week-over-week
 *     trend lines per project.
 *   - `blockedIssues` per project: real Jira "Blocks" issue-link
 *     dependencies (falls back to a "Blocked" component tag if no
 *     formal link exists).
 *   - Quality loop-back rate now reports the exact count (regressed /
 *     sample size) alongside the percentage, both overall and per week.
 *
 * IMPORTANT / CURRENT STATE (July 2026):
 * There is no "Pod" or "Delivery Manager" field in Jira today, so this
 * script reports metrics per real Jira PROJECT (INV, APCOM, EMP, CORE,
 * MOBILE, BOA, EXP, HR). When Pods/DMs are introduced in Jira, update
 * PROJECTS below and the grouping logic in main() -- the JQL and math
 * stay the same.
 *
 * NOTE: Uses Jira Cloud's POST /rest/api/3/search/jql endpoint (the old
 * GET /rest/api/3/search endpoint was retired by Atlassian -- see
 * https://developer.atlassian.com/changelog/#CHANGE-2046). `expand` must
 * be sent as a comma-separated string, not an array, or Jira returns a
 * 400 "Invalid request payload".
 */

const PROJECTS = ["INV", "APCOM", "EMP", "CORE", "MOBILE", "BOA", "EXP", "HR"];
const WINDOW_DAYS = 56; // rolling 8 weeks
const WEEK_MS = 7 * 86400000;
const AGING_WIP_THRESHOLD_DAYS = 14; // open issues older than this are flagged as "aging"

const BASE_URL = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error("Missing JIRA_BASE_URL, JIRA_EMAIL, or JIRA_API_TOKEN environment variables.");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");

// Standard Jira status category order: To Do -> In Progress -> Done
const CATEGORY_ORDER = { 2: 0, 4: 1, 3: 2 }; // new=2, indeterminate=4, done=3

async function jiraFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: AUTH, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Jira API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function searchAll(jql, fields, expand, cap = 1000) {
  const issues = [];
  let nextPageToken;
  let page = 0;
  while (issues.length < cap) {
    page++;
    const body = {
      jql,
      maxResults: 100,
      fields,
      ...(expand ? { expand: Array.isArray(expand) ? expand.join(",") : expand } : {}),
      ...(nextPageToken ? { nextPageToken } : {}),
    };
    const res = await fetch(`${BASE_URL}/rest/api/3/search/jql`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Jira search failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    // Diagnostic logging: prints what actually came back for every query.
    // If Jira silently ignores or partially misparses part of the JQL, it
    // can return HTTP 200 with an empty issues array plus a warningMessages
    // field explaining what was dropped -- surface that here instead of
    // failing silently, since that's the #1 suspect for "no error, but zero
    // results" behavior.
    if (page === 1) {
      console.log(`  JQL: ${jql}`);
      console.log(`  -> returned ${data.issues ? data.issues.length : 0} issue(s) on page 1`);
      if (data.warningMessages && data.warningMessages.length) {
        console.log(`  ! Jira warningMessages: ${JSON.stringify(data.warningMessages)}`);
      }
      if (!data.issues || !data.issues.length) {
        console.log(`  ! Empty result, raw response: ${JSON.stringify(data).slice(0, 1000)}`);
      }
    }
    issues.push(...data.issues);
    if (data.isLast || !data.nextPageToken || !data.issues.length) break;
    nextPageToken = data.nextPageToken;
  }
  return issues;
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round1(n) {
  return n === null || n === undefined ? null : Number(n.toFixed(1));
}

function isAiComponent(name) {
  return /claude|ai/i.test(name || "");
}

function isBlockedComponent(name) {
  return /blocked/i.test(name || "");
}

/** Analyze one issue's status changelog for cycle time, lead time, and regressions. */
function analyzeIssue(issue, statusCategoryByName) {
  const created = new Date(issue.fields.created).getTime();
  const resolved = issue.fields.resolutiondate ? new Date(issue.fields.resolutiondate).getTime() : null;

  const histories = (issue.changelog?.histories || [])
    .flatMap((h) =>
      h.items
        .filter((i) => i.field === "status")
        .map((i) => ({ ts: new Date(h.created).getTime(), from: i.fromString, to: i.toString }))
    )
    .sort((a, b) => a.ts - b.ts);

  let startInProgress = null;
  let regressions = 0;

  for (const t of histories) {
    const fromCat = statusCategoryByName[t.from];
    const toCat = statusCategoryByName[t.to];
    if (startInProgress === null && toCat === 4) startInProgress = t.ts;
    if (fromCat != null && toCat != null && CATEGORY_ORDER[toCat] < CATEGORY_ORDER[fromCat]) {
      regressions++;
    }
  }

  // Edge case: issue created directly into an in-progress/done status with no changelog.
  if (startInProgress === null && histories.length === 0) {
    const curCat = statusCategoryByName[issue.fields.status.name];
    if (curCat === 4 || curCat === 3) startInProgress = created;
  }

  let cycleTimeDays = null;
  if (resolved && startInProgress) cycleTimeDays = (resolved - startInProgress) / 86400000;

  let leadTimeDays = null;
  if (resolved) leadTimeDays = (resolved - created) / 86400000;

  const hadTransition = histories.length > 0;
  const isAiTagged = (issue.fields.components || []).some((c) => isAiComponent(c.name));

  return { cycleTimeDays, leadTimeDays, regressed: regressions > 0, hadTransition, isAiTagged, resolved };
}

async function fetchStatusCategoryMap() {
  const statuses = await jiraFetch("/rest/api/3/status");
  const map = {};
  for (const s of statuses) map[s.name] = s.statusCategory.id;
  return map;
}

function summarize(analyzed) {
  const withCycleTime = analyzed.filter((a) => a.cycleTimeDays !== null).map((a) => a.cycleTimeDays);
  const withLeadTime = analyzed.filter((a) => a.leadTimeDays !== null).map((a) => a.leadTimeDays);
  const withTransitions = analyzed.filter((a) => a.hadTransition);
  const regressed = withTransitions.filter((a) => a.regressed);
  const aiTagged = analyzed.filter((a) => a.isAiTagged);

  const cycleTimeAvg = round1(avg(withCycleTime));
  const leadTimeAvg = round1(avg(withLeadTime));
  // Flow efficiency: cycle time (the "in progress" window) as a share of lead
  // time (the full created -> resolved span). Lower numbers mean more of an
  // issue's life is spent waiting rather than being actively worked. This is
  // an aggregate-average approximation (ratio of the two averages above), not
  // a true per-issue active/wait breakdown -- Jira doesn't track "waiting" as
  // its own status category out of the box, so a precise figure would need a
  // customized workflow with explicit wait states.
  const flowEfficiencyPct = (cycleTimeAvg !== null && leadTimeAvg) ? round1((cycleTimeAvg / leadTimeAvg) * 100) : null;

  return {
    throughput: analyzed.length,
    cycleTimeAvg,
    cycleTimeMedian: round1(median(withCycleTime)),
    cycleTimeSampleSize: withCycleTime.length,
    leadTimeAvg,
    leadTimeMedian: round1(median(withLeadTime)),
    leadTimeSampleSize: withLeadTime.length,
    flowEfficiencyPct,
    qualityLoopbackRatePct: withTransitions.length ? round1((regressed.length / withTransitions.length) * 100) : null,
    qualityLoopbackCount: regressed.length,
    qualityLoopbackSampleSize: withTransitions.length,
    aiLeverageRatePct: analyzed.length ? round1((aiTagged.length / analyzed.length) * 100) : null,
  };
}

function weekLabel(startMs, endMs) {
  const fmt = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(startMs)}–${fmt(endMs)}`;
}

async function analyzeProject(key, statusCategoryByName) {
  const now = Date.now();

  // WIP snapshot: all currently open issues, grouped by status (not time-windowed).
  // Also pull issuelinks so we can surface real "blocked by" dependencies, not just a
  // "Blocked" component guess. Jira embeds a minimal fields object (key, summary, status)
  // on each linked issue automatically, so no extra API calls are needed.
  const wipIssues = await searchAll(`project = ${key} AND statusCategory != Done`, ["status", "summary", "issuelinks", "components", "created"]);
  const wipByStatus = {};
  for (const issue of wipIssues) {
    const name = issue.fields.status.name;
    wipByStatus[name] = (wipByStatus[name] || 0) + 1;
  }

  // Aging WIP: how long has each open issue been open? Uses the "created" date
  // as a low-cost proxy for "time in flight" -- an exact "time in current
  // column" reading would need each issue's changelog, which is expensive to
  // pull for every open issue on every run. Flags anything older than
  // AGING_WIP_THRESHOLD_DAYS and keeps the oldest few so a team can see what's
  // stuck before it quietly drags the cycle-time average up.
  const wipWithAge = wipIssues.map((issue) => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    ageDays: round1((now - new Date(issue.fields.created).getTime()) / 86400000),
  }));
  const oldestWipAgeDays = wipWithAge.length ? Math.max(...wipWithAge.map((w) => w.ageDays)) : null;
  const agingWipCount = wipWithAge.filter((w) => w.ageDays > AGING_WIP_THRESHOLD_DAYS).length;
  const agingWipIssues = [...wipWithAge].sort((a, b) => b.ageDays - a.ageDays).slice(0, 5);

  // Dependencies: for each open issue, find "Blocks" links where THIS issue is the
  // one being blocked (an inwardIssue under a "Blocks" type link), and keep only
  // blockers that are themselves still open (not Done).
  // Every blocker is tagged with a "scope": if the blocking issue lives in the
  // same Jira project, it's "internal" (your own team can unblock it); if it
  // lives in a different Jira project, it's "external" (you're waiting on
  // another team). This is derived purely from the issue key prefix, so it
  // needs no extra Jira fields or config.
  const blockedIssues = [];
  for (const issue of wipIssues) {
    const links = issue.fields.issuelinks || [];
    const blockers = links
      .filter((l) => l.type && l.type.name === "Blocks" && l.inwardIssue)
      .map((l) => {
        const bFields = l.inwardIssue.fields || {};
        const bCat = bFields.status && bFields.status.statusCategory ? bFields.status.statusCategory.key : null;
        const bKey = l.inwardIssue.key;
        const bProject = bKey.split("-")[0];
        return {
          key: bKey,
          summary: bFields.summary || null,
          status: bFields.status ? bFields.status.name : null,
          isOpen: bCat ? bCat !== "done" : true,
          scope: bProject === key ? "internal" : "external",
        };
      })
      .filter((b) => b.isOpen);
    if (blockers.length) {
      blockedIssues.push({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        blockedBy: blockers.map((b) => ({ key: b.key, summary: b.summary, status: b.status, scope: b.scope })),
      });
    }
  }
  // Fall back to the "Blocked" component tag for issues that are flagged that way
  // but don't (yet) have a formal Jira issue link recorded. Scope is unknown here
  // (no linked issue to compare project keys against), so the front end treats
  // blockedBy: [] as "flagged, no linked issue on record."
  const linkedKeys = new Set(blockedIssues.map((b) => b.key));
  for (const issue of wipIssues) {
    if (linkedKeys.has(issue.key)) continue;
    if ((issue.fields.components || []).some((c) => isBlockedComponent(c.name))) {
      blockedIssues.push({ key: issue.key, summary: issue.fields.summary, status: issue.fields.status.name, blockedBy: [] });
    }
  }
  const openBlockers = blockedIssues.length;
  const internalBlockerCount = blockedIssues.reduce(
    (acc, b) => acc + b.blockedBy.filter((x) => x.scope === "internal").length,
    0
  );
  const externalBlockerCount = blockedIssues.reduce(
    (acc, b) => acc + b.blockedBy.filter((x) => x.scope === "external").length,
    0
  );

  // Rolling 8-week window, relative to right now.
  const windowIssues = await searchAll(
    `project = ${key} AND resolutiondate >= -${WINDOW_DAYS}d`,
    ["created", "resolutiondate", "components", "status"],
    "changelog"
  );
  const analyzed = windowIssues.map((i) => analyzeIssue(i, statusCategoryByName));

  // Weekly buckets: index 0 = oldest week (49-56 days ago), index 7 = this week (0-7 days ago).
  const buckets = Array.from({ length: 8 }, () => []);
  for (const a of analyzed) {
    if (!a.resolved) continue;
    const daysAgo = (now - a.resolved) / 86400000;
    const weekFromToday = Math.min(7, Math.floor(daysAgo / 7)); // 0 = this week ... 7 = oldest week
    const bucketIndex = 7 - weekFromToday; // flip so array is oldest -> newest
    buckets[bucketIndex].push(a);
  }

  const weekly = buckets.map((bucketIssues, i) => {
    const weeksAgo = 7 - i; // 7 = oldest, 0 = current week
    const endMs = now - weeksAgo * WEEK_MS;
    const startMs = endMs - WEEK_MS;
    const s = summarize(bucketIssues);
    return {
      label: weekLabel(startMs, endMs),
      weekStart: new Date(startMs).toISOString(),
      weekEnd: new Date(endMs).toISOString(),
      throughput: s.throughput,
      cycleTimeAvg: s.cycleTimeAvg,
      leadTimeAvg: s.leadTimeAvg,
      flowEfficiencyPct: s.flowEfficiencyPct,
      qualityLoopbackRatePct: s.qualityLoopbackRatePct,
      qualityLoopbackCount: s.qualityLoopbackCount,
      qualityLoopbackSampleSize: s.qualityLoopbackSampleSize,
      aiLeverageRatePct: s.aiLeverageRatePct,
    };
  });

  const overall = summarize(analyzed);
  const thisWeek = weekly[weekly.length - 1];

  return {
    key,
    wipByStatus,
    wipTotal: wipIssues.length,
    openBlockers,
    internalBlockerCount,
    externalBlockerCount,
    blockedIssues,
    oldestWipAgeDays,
    agingWipCount,
    agingWipIssues,
    windowDays: WINDOW_DAYS,
    cycleTimeDays: { avg: overall.cycleTimeAvg, median: overall.cycleTimeMedian, sampleSize: overall.cycleTimeSampleSize },
    leadTimeDays: { avg: overall.leadTimeAvg, median: overall.leadTimeMedian, sampleSize: overall.leadTimeSampleSize },
    flowEfficiencyPct: overall.flowEfficiencyPct,
    throughput7d: thisWeek ? thisWeek.throughput : 0,
    throughputWindowTotal: overall.throughput,
    throughputAvgPerWeek: round1(overall.throughput / 8),
    qualityLoopbackRatePct: overall.qualityLoopbackRatePct,
    qualityLoopbackCount: overall.qualityLoopbackCount,
    qualityLoopbackSampleSize: overall.qualityLoopbackSampleSize,
    aiLeverageRatePct: overall.aiLeverageRatePct,
    weekly,
  };
}

async function main() {
  const statusCategoryByName = await fetchStatusCategoryMap();

  const projects = [];
  for (const key of PROJECTS) {
    console.log(`Analyzing ${key}...`);
    try {
      projects.push(await analyzeProject(key, statusCategoryByName));
    } catch (err) {
      console.error(`Failed to analyze ${key}: ${err.message}`);
      projects.push({ key, error: err.message });
    }
  }

  // This script overwrites data.json every run (every 3 hours, per the GitHub
  // Action), which used to wipe out any hand-edited "manual" fields. Read
  // whatever's already there first so hand-maintained data -- Focus Integrity
  // and Team Pulse -- survives.
  const fs = require("fs");
  let existingManual = {};
  try {
    existingManual = JSON.parse(fs.readFileSync("data.json", "utf8")).manual || {};
  } catch {
    // No existing data.json (first run) -- fall back to empty defaults below.
  }

  const out = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    groupingNote:
      "Metrics are grouped by real Jira project (no Pod/DM field exists yet). Update PROJECTS + grouping in fetch-jira-data.js once Pods/DMs are tracked in Jira.",
    projects,
    manual: {
      focusIntegrity: existingManual.focusIntegrity ?? null,
      teamPulse: existingManual.teamPulse ?? null,
      note: "Focus Integrity and Team Pulse have no Jira data source. Edit them directly in data.json's `manual` section -- this script preserves them across runs instead of overwriting them.",
    },
  };

  fs.writeFileSync("data.json", JSON.stringify(out, null, 2));
  console.log("Wrote data.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
