// ── THE WEEKLY RESULTS DIGEST ────────────────────────────────────
// A scheduled function, not a page: nothing in the client calls it and it
// answers nobody's request except the scheduler's. It reads the week that
// has just closed and sends three shapes of email - one to each person who
// filed, one to each leader about their own people, one to the two tiers
// who answer for the whole floor.
//
// WHAT A RESULT IS, HERE. The money filed on the Weekly Results screen:
// sales_dub_received + sales_lim_received for that cycle. That screen's own
// headline is "Received in total" and this is the same arithmetic, so a
// person reading the mail and then opening the screen sees one number.
//
// It is deliberately NOT the figure on the Performance screen. That one is
// the Google forecast sheet plus result_extras, monthly, and the two sources
// do not agree - they are not meant to. This digest is about the week that
// just closed, so it reads what was filed for that week and says so.
//
// TARGETS ARE MONTHLY and there is no weekly one anywhere in the schema, so
// the week's figure is reported on its own and the AHEAD/BEHIND sentence is
// about the month to date, which is the only comparison where both sides
// cover the same ground. agentTargetFor and campusTargetFor are required
// from db.js rather than reimplemented: a second answer to "what is this
// person's target" is how two screens start disagreeing.
const { createClient } = require('@supabase/supabase-js');
const api = require('./db.js');

const { emailHtml, sendEmail, APP_URL } = api.__email;
const { ROLE_RANK, rank, isLocalLeader } = api.__rank;
const { campusTargetFor, beforeStart, agentTargetFor } = api.__targets;
const { subtreeIds } = api.__scope;
const { dayOfWeekStart } = api.__dates;

// Its own client, on the same service-role key db.js uses. The browser never
// reaches this function at all: it has no redirect in netlify.toml and the
// only unauthenticated way in is the scheduler.
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

function json(code, body){ return { statusCode: code,
  headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) }; }

// ── THE CLOCK ────────────────────────────────────────────────────
// Netlify cron is UTC and Dublin is not: UTC in winter, UTC+1 in summer. A
// single UTC cron would therefore land at 15:00 for half the year and 16:00
// for the other half. So the job is scheduled at BOTH 14:00 and 15:00 UTC
// and throws away the run whose Dublin hour is not 15. Exactly one of the
// two survives, year round, and the dedup log is the second guard behind it.
const DIGEST_HOUR = 15;
function dublinHour(now){
  const s = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Dublin',
    hour:'2-digit', hourCycle:'h23' }).format(now);
  return Number(s);
}
// Pinned by the suite, and by nothing else. Not read from the environment
// and not from the request, so no header, payload or setting can move the
// clock this job runs on.
let __digestClock = null;
function digestNow(){ return __digestClock || new Date(); }
exports.__setDigestClock = (d) => { __digestClock = (d instanceof Date) ? d : null; };

// ── THE WEEK ─────────────────────────────────────────────────────
// A cycle is identified by its MONDAY, and the week this job is about is the
// one that has just closed, which is the Monday of the day it runs. The
// Friday is Monday + 4: every filing window in db.js sits inside Mon to Fri
// and nothing in the weekly model touches a weekend.
function weekKeyFor(now){ return api.__dates.mondayOfWeek(now); }
function fridayOf(weekKey){ return dayOfWeekStart(weekKey, 4); }
// Which month a week belongs to: the month its FRIDAY falls in. A week that
// straddles a month end belongs to the month it finished in, so a week is
// never counted twice and never dropped.
function monthOfWeek(weekKey){
  const [y,m] = fridayOf(weekKey).split('-').map(Number);
  return { year:y, month:m };
}

const euro = n => '€' + Math.round(Number(n) || 0).toLocaleString('en-IE');
const nameOf = u => [u && u.first, u && u.last].filter(Boolean).join(' ').trim()
  || (u && u.nickname) || 'there';

// ── READING THE WEEK ─────────────────────────────────────────────
// Every cycle whose Friday falls in the same month as the target week's, up
// to and including it. One query for the cycles, one for their entries.
async function loadWeek(weekKey){
  const { year, month } = monthOfWeek(weekKey);
  const { data: cycles } = await admin.from('weekly_cycles').select('id,week_start');
  const all = cycles || [];
  const thisWeek = all.find(c => String(c.week_start) === String(weekKey)) || null;
  const mtdCycles = all.filter(c => {
    const f = fridayOf(c.week_start);
    const [y,m] = f.split('-').map(Number);
    return y === year && m === month && f <= fridayOf(weekKey);
  });
  const ids = mtdCycles.map(c => c.id);
  const { data: entries } = ids.length
    ? await admin.from('weekly_entries')
        .select('id,cycle_id,user_id,sales_dub_received,sales_lim_received').in('cycle_id', ids)
    : { data: [] };
  return { year, month, cycle: thisWeek, cycles: mtdCycles, entries: entries || [] };
}
// ── THE PAYLOADS ─────────────────────────────────────────────────
// Built whole, before anything is sent, so preview and the real run are the
// same computation and a preview cannot drift from what would go out.
async function buildPayloads(weekKey){
  const wk = await loadWeek(weekKey);
  if(!wk.cycle) return { week_key: weekKey, friday: fridayOf(weekKey), none:'no_cycle', items:[] };

  const weekBy = {};            // user_id -> this week's received
  const mtdBy  = {};            // user_id -> month to date received
  let weekDub = 0, weekLim = 0, mtdDub = 0, mtdLim = 0;
  wk.entries.forEach(e => {
    const uid = String(e.user_id);
    const dub = Number(e.sales_dub_received) || 0;
    const lim = Number(e.sales_lim_received) || 0;
    mtdBy[uid] = (mtdBy[uid] || 0) + dub + lim;
    mtdDub += dub; mtdLim += lim;
    if(String(e.cycle_id) === String(wk.cycle.id)){
      weekBy[uid] = (weekBy[uid] || 0) + dub + lim;
      weekDub += dub; weekLim += lim;
    }
  });

  const { data: profs } = await admin.from('profiles')
    .select('id,first,last,nickname,email,role,role_id,campus,reports_to,status,start_date,monthly_target');
  const people = (profs || []).filter(u => u.status !== 'inactive');
  const byId = {}; people.forEach(u => { byId[String(u.id)] = u; });

  // The target side, read exactly as the Performance screen reads it.
  const { data: srRows } = await admin.from('sales_results')
    .select('user_id,year,month,target').eq('year', wk.year);
  const byUserMonth = {};
  (srRows || []).forEach(r => {
    const u = byUserMonth[String(r.user_id)] || (byUserMonth[String(r.user_id)] = {});
    u[Number(r.month)] = r;
  });
  const { data: roleRows } = await admin.from('roles').select('id,name,individual_target');
  const roleById = {}; (roleRows || []).forEach(r => { roleById[String(r.id)] = r; });
  const { data: ctRows } = await admin.from('campus_targets').select('campus,year,month,amount');

  // A person who started after this month has no target to be measured
  // against, which is a state and not a zero.
  const targetOf = (u) => {
    if(beforeStart(u, wk.year, wk.month)) return null;
    const cargo = u.role_id != null ? roleById[String(u.role_id)] : null;
    const ladder = cargo && cargo.individual_target != null
      ? Number(cargo.individual_target)
      : (u.monthly_target != null ? Number(u.monthly_target) : 0);
    return agentTargetFor(byUserMonth, u.id, wk.year, wk.month, ladder);
  };

  const filed = Object.keys(weekBy).filter(uid => byId[uid]);
  const items = [];

  // ── AGENT ──────────────────────────────────────────────────────
  filed.forEach(uid => {
    const u = byId[uid];
    if(!u.email) return;                       // nowhere to send it
    const week = weekBy[uid] || 0;
    const mtd  = mtdBy[uid] || 0;
    const target = targetOf(u);
    const lines = [
      'Your result this week: ' + euro(week) + '.',
      'This month so far: ' + euro(mtd) + '.',
    ];
    if(target === null){
      lines.push('No target applies to you this month yet.');
    } else {
      lines.push('Target for ' + monthName(wk.month) + ': ' + euro(target) + '.');
      const gap = mtd - target;
      lines.push(gap >= 0
        ? euro(Math.abs(gap)) + ' ahead of target.'
        : euro(Math.abs(gap)) + ' to go.');
    }
    items.push({ kind:'agent', recipient_id: u.id, to: u.email,
      subject: 'Your week at NED - ' + fridayOf(weekKey),
      html: emailHtml({
        heading: 'Hi ' + (u.first || nameOf(u)) + ',',
        lines,
        button: 'Open SalesHub', url: APP_URL,
        note: 'Figures are what was filed on the Weekly Results screen for the week ending '
              + fridayOf(weekKey) + '.'
      }),
      figures: { week, mtd, target } });
  });

  // ── MANAGER ────────────────────────────────────────────────────
  // Every local leader whose own branch filed something. Their own row is
  // not in the table: this is about the people they lead.
  const leaders = people.filter(u => isLocalLeader(u.role) && u.email);
  for(const u of leaders){
    const sub = await subtreeIds(u);
    const mine = filed.filter(id => sub.has(byId[id].id));
    if(!mine.length) continue;
    const rows = mine
      .map(id => ({ u: byId[id], week: weekBy[id] || 0, target: targetOf(byId[id]) }))
      .sort((a,b) => b.week - a.week || nameOf(a.u).localeCompare(nameOf(b.u)));
    const teamWeek = rows.reduce((a,r) => a + r.week, 0);
    const teamTarget = rows.reduce((a,r) => a + (r.target || 0), 0);
    items.push({ kind:'manager', recipient_id: u.id, to: u.email,
      subject: 'Your team this week - ' + fridayOf(weekKey),
      html: emailHtml({
        heading: 'Hi ' + (u.first || nameOf(u)) + ',',
        lines: ['Here is how your people finished the week ending ' + fridayOf(weekKey) + '.'],
        table: {
          head: ['Person', 'This week', 'Month target'],
          rows: rows.map(r => [nameOf(r.u), euro(r.week),
                               r.target === null ? '-' : euro(r.target)]),
          total: ['Team total', euro(teamWeek), euro(teamTarget)]
        },
        button: 'Open SalesHub', url: APP_URL,
        note: 'The week figure is what each person filed on the Weekly Results screen. '
            + 'The target is their monthly one.'
      }),
      figures: { members: rows.length, teamWeek, teamTarget } });
  }

  // ── LEADERSHIP ─────────────────────────────────────────────────
  // The two campus columns ARE the campuses: a person can sell to both, and
  // the filed figure already says which. So the split comes off the columns
  // and never off profiles.campus.
  const campusRows = [
    { key:'dublin',   label:'Dublin',   week:weekDub, mtd:mtdDub },
    { key:'limerick', label:'Limerick', week:weekLim, mtd:mtdLim },
  ].map(c => Object.assign(c, {
    target: campusTargetFor(ctRows || [], c.key, wk.year, wk.month)
  }));
  const coWeek = weekDub + weekLim;
  const coMtd  = mtdDub + mtdLim;
  const coTarget = campusRows.reduce((a,c) => a + (c.target || 0), 0);
  // Rank, and only rank: a director or an admin. A cargo named General
  // Sales Manager is not a rung on this ladder, whatever the ranking board
  // lets that cargo look at.
  const chiefs = people.filter(u => u.email && rank(u.role) >= ROLE_RANK.director);
  chiefs.forEach(u => {
    items.push({ kind:'leadership', recipient_id: u.id, to: u.email,
      subject: 'NED weekly results - ' + fridayOf(weekKey),
      html: emailHtml({
        heading: 'Week ending ' + fridayOf(weekKey),
        lines: ['Filed results for the week, and where each campus stands this month.'],
        table: {
          head: ['Campus', 'This week', 'Month to date', 'Month target'],
          rows: campusRows.map(c => [c.label, euro(c.week), euro(c.mtd),
                                     c.target === null ? '-' : euro(c.target)]),
          total: ['Company', euro(coWeek), euro(coMtd), euro(coTarget)]
        },
        button: 'Open SalesHub', url: APP_URL,
        note: 'Figures are what was filed on the Weekly Results screen. '
            + 'Campus targets are the monthly ones set by a director.'
      }),
      figures: { campuses: campusRows.map(c => ({ campus:c.key, week:c.week,
                                                  mtd:c.mtd, target:c.target })),
                 coWeek, coMtd, coTarget } });
  });

  return { week_key: weekKey, friday: fridayOf(weekKey),
           year: wk.year, month: wk.month, items };
}
const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];
function monthName(m){ return MONTHS[Number(m) - 1] || ''; }

// ── SENDING ──────────────────────────────────────────────────────
// Best effort, one at a time, exactly the contract the welcome email has:
// a failure is logged and the run carries on. A send that did not happen is
// never written to the log, so the next run picks it up.
async function deliver(payload){
  const { data: already } = await admin.from('weekly_digest_log')
    .select('week_key,recipient_id,kind').eq('week_key', payload.week_key);
  const seen = new Set((already || []).map(r =>
    String(r.recipient_id) + '|' + String(r.kind)));
  const out = { sent:0, skipped:0, failed:0, log:[] };
  for(const it of payload.items){
    const key = String(it.recipient_id) + '|' + it.kind;
    if(seen.has(key)){ out.skipped++; out.log.push({ kind:it.kind, to:it.to, state:'already_sent' }); continue; }
    // sendEmail never throws - that is its contract, and the welcome email
    // leans on it the same way. It answers with {ok:false,...} instead, and
    // a falsy answer is read the same way, so one failure can never take the
    // rest of the run with it.
    const res = await sendEmail({ to: it.to, subject: it.subject, html: it.html });
    if(!res || res.ok !== true){
      out.failed++; out.log.push({ kind:it.kind, to:it.to, state:'failed' });
      continue;                                 // not logged, so it retries
    }
    const { error } = await admin.from('weekly_digest_log').insert({
      week_key: payload.week_key, recipient_id: it.recipient_id, kind: it.kind });
    // 23505 means another run got there first. The mail is out either way,
    // and the row it clashed with says so.
    if(error && error.code !== '23505'){
      out.sent++; out.log.push({ kind:it.kind, to:it.to, state:'sent_unlogged' });
      continue;
    }
    seen.add(key);
    out.sent++; out.log.push({ kind:it.kind, to:it.to, state:'sent' });
  }
  return out;
}

// ── PREVIEW ──────────────────────────────────────────────────────
// For checking the thing before the first real Friday. It computes exactly
// what a real run would compute and returns it; it never reaches deliver(),
// so there is no path from here to an email. Admin only, through the same
// bearer token the gateway uses.
async function previewCaller(event){
  const h = (event && event.headers &&
    (event.headers.authorization || event.headers.Authorization)) || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if(error || !data || !data.user) return null;
  const { data: me } = await admin.from('profiles')
    .select('id,role').eq('id', data.user.id).single();
  if(!me || rank(me.role) < ROLE_RANK.admin) return null;
  return me;
}
function wantsPreview(event){
  const q = (event && (event.queryStringParameters || {})) || {};
  return String(q.preview || '') === '1';
}

exports.handler = async (event) => {
  const now = digestNow();
  if(wantsPreview(event || {})){
    const me = await previewCaller(event || {});
    if(!me) return json(403, { error:'forbidden' });
    // The hour guard is deliberately not applied: a preview is for any day.
    // What a preview cannot do is send, and it reaches no code that can.
    const payload = await buildPayloads(weekKeyFor(now));
    return json(200, { ok:true, preview:true, sent:false,
      week_key: payload.week_key, friday: payload.friday,
      recipients: payload.items.map(i => ({ kind:i.kind, to:i.to,
        recipient_id:i.recipient_id, subject:i.subject, figures:i.figures })),
      items: payload.items });
  }
  const hour = dublinHour(now);
  if(hour !== DIGEST_HOUR){
    // The other of the two UTC crons. Half the year this is the 14:00 one
    // and half the year it is the 15:00 one; either way exactly one run a
    // Friday gets past here.
    return json(200, { ok:true, skipped:'not_digest_hour', dublin_hour: hour });
  }
  const payload = await buildPayloads(weekKeyFor(now));
  if(payload.none) return json(200, { ok:true, skipped: payload.none, week_key: payload.week_key });
  const out = await deliver(payload);
  return json(200, { ok:true, week_key: payload.week_key, friday: payload.friday,
    sent: out.sent, skipped: out.skipped, failed: out.failed, log: out.log });
};

exports.__digest = { buildPayloads, deliver, dublinHour, weekKeyFor, fridayOf,
  monthOfWeek, euro, DIGEST_HOUR };
