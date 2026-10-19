const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false }
});
function json(code, body){ return { statusCode: code,
  headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) }; }
async function getCaller(event){
  const h = event.headers.authorization || event.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if(error || !data || !data.user) return null;
  return data.user;
}
async function callerProfile(caller){
  const { data } = await admin.from('profiles').select('*').eq('id', caller.id).single();
  return data || null;
}
// ── ROLE HIERARCHY ───────────────────────────────────────────────
// Until now every "who may act on whom" rule was a hand-written
// `tgt.role !== 'director'`, repeated a dozen times. One rank table replaces
// them all: you may act on anyone at your own tier or below, never above.
// 'admin' has a rank here before it exists as a tier, so adding it later
// changes no behaviour on its own.
const ROLE_RANK = { agent:0, specialist:0, executive:0, senior_exec:0, leader:1,
  supervisor:2, manager:3, director:4, admin:5 };
function rank(r){ const v = ROLE_RANK[r]; return (v===undefined) ? 0 : v; }
function outranks(meRole, targetRole){ return rank(meRole) >= rank(targetRole); }

// "Leadership" is now a floor, not a list: manager and up. This answers WHO
// MAY USE a management action at all - never WHOM it may be used on. The two
// questions were the same thing while every tier above supervisor reached the
// whole company; they are not any more, so do NOT tighten this: shrinking it
// would shrink director and admin too.
function isMgr(role){ return rank(role) >= ROLE_RANK.manager; }

// ── VIEW WITHOUT AUTHORITY ───────────────────────────────────────
// Until now "sees the whole company" and "may act on the whole company" were
// the same predicate: rank. 'senior_exec' breaks that - it reads everything
// and may act on nobody - so it cannot be expressed as a rank floor and gets
// its own list. Membership here grants READ scope and nothing else: every
// write gate is rank- or isMgr-based and senior_exec is rank 0.
const VIEW_ALL_ROLES = ['senior_exec'];
// Tiers that can have people reporting to them. NOT the same question as rank:
// 'senior_exec' sits at rank 0 and reads the whole company, but leads nobody,
// and the individual contributors lead nobody either.
const LEADER_ROLES = new Set(['leader','supervisor','manager','director','admin']);
function seesEverything(role){ return VIEW_ALL_ROLES.includes(role); }

// ── SCOPE: WHERE a caller's authority reaches ────────────────────
// Rank answers who you may act ON. It never answered WHERE, because until now
// everyone above supervisor reached the whole company and the question did not
// exist. 'manager' is now LOCAL: their own branch of reports_to, transitively,
// exactly like supervisor and leader. So the company-wide tiers are named
// outright instead of being inferred from a rank floor.
// Deliberately NOT isMgr(): that floor still has to include manager, or
// managers would lose the management screens altogether.
function seesWholeCompany(role){
  return rank(role) >= ROLE_RANK.director || seesEverything(role);
}
// The tiers whose reach is their own branch and nothing else. A list rather
// than a rank window because it is not one: manager sits above supervisor in
// rank and beside it in scope.
function isLocalLeader(role){
  return role === 'manager' || role === 'supervisor' || role === 'leader';
}
// The people inside a caller's scope, themselves included. `null` means
// "everyone" so a caller can skip filtering altogether rather than materialise
// the whole directory.
async function scopeIdsFor(me){
  if(seesWholeCompany(me.role)) return null;
  if(isLocalLeader(me.role)){
    const ids = await subtreeIds(me);
    ids.add(me.id);
    return ids;
  }
  return new Set([me.id]);
}
// The one "may I act on this person" predicate, shared by every write gate.
// Two independent questions, both of which must pass for a local leader: is
// this person in my branch, and do I outrank them.
async function canActOn(me, tgt){
  if(!me || !tgt) return false;
  // Reads everything, commands nobody. First, so no rank arithmetic below can
  // accidentally let a rank-0 viewer act on a rank-0 person.
  if(seesEverything(me.role)) return false;
  if(rank(me.role) >= ROLE_RANK.director) return outranks(me.role, tgt.role);
  if(isLocalLeader(me.role))
    return (await subtreeIds(me)).has(tgt.id) && outranks(me.role, tgt.role);
  return false;
}

const ROLE_TARGETS = { agent:14000, specialist:17000, executive:20000, leader:22000,
  supervisor:22000, manager:0, director:0, admin:0, senior_exec:0 };
function canUpdatePerf(role){ return rank(role) >= ROLE_RANK.supervisor; }
// Whose sales figures a caller may write. Your own are always in scope - both
// call sites have already established you may write figures at all - and
// everyone else is the ordinary "may I act on this person" question.
async function inScope(me, tgt){
  if(String(tgt.id) === String(me.id)) return true;
  return canActOn(me, tgt);
}
// Mirrors the user_role enum in Postgres, lowest tier first. 'admin' sits
// above 'director': same reach, plus the three places a director was named
// outright. 'senior_exec' sits at rank 0 with the individual contributors -
// it reads company-wide but commands nobody, so it is NOT ordered by what it
// can see. Nothing holds either until someone is given it.
const ROLE_LEVELS = ['agent','specialist','executive','senior_exec','leader','supervisor','manager','director','admin'];
// null / '' clears the value; a bad number returns false so callers can 400.
// ── WEEKLY RESULTS ───────────────────────────────────────────────
// Everyone files their own line each week: sales per campus, leads per
// source. Consolidation and the submission clock are later parts; nothing
// here gates on time, and nobody can write anybody else's row.
//
// The week runs Monday to Sunday in Europe/Dublin, which is NOT the server's
// clock - a Netlify function runs in UTC, and from late March to late October
// Dublin is an hour ahead. Formatting the instant in that zone and reading
// the date parts back is what makes "Monday" mean Monday in Dublin at 00:30
// on a summer Monday, where a UTC read still says Sunday.
function dublinYMD(d){
  const f = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Dublin',
    year:'numeric', month:'2-digit', day:'2-digit' });
  return f.format(d);            // 'YYYY-MM-DD'
}
function dublinWeekday(d){
  // 1 = Monday ... 7 = Sunday, read in Dublin rather than UTC.
  const name = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Dublin', weekday:'short' }).format(d);
  const idx = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(name);
  return idx < 0 ? 1 : idx + 1;
}
// The Monday of the week containing `now`, as a plain YYYY-MM-DD date string.
// Subtracting whole days from the Dublin date (not from the instant) keeps a
// DST changeover from landing the answer on Sunday or Tuesday.
function mondayOfWeek(now){
  const ymd = dublinYMD(now);
  const back = dublinWeekday(now) - 1;
  const [y,m,d] = ymd.split('-').map(Number);
  const noon = Date.UTC(y, m-1, d, 12, 0, 0) - back*86400000;
  const dt = new Date(noon);
  return [dt.getUTCFullYear(),
          String(dt.getUTCMonth()+1).padStart(2,'0'),
          String(dt.getUTCDate()).padStart(2,'0')].join('-');
}
// Find or open this week's cycle. Two people loading the page at once can
// both miss the row and both insert it, so a unique violation on week_start
// means somebody won the race - re-read rather than fail.
async function currentCycle(){
  const week_start = mondayOfWeek(new Date());
  const { data: found } = await admin.from('weekly_cycles')
    .select('id,week_start').eq('week_start', week_start).single();
  if(found) return { ok:true, cycle:{ id:found.id, week_start:found.week_start } };
  const { data: made, error } = await admin.from('weekly_cycles')
    .insert({ week_start, status:'open' }).select('id,week_start').single();
  if(!error && made) return { ok:true, cycle:{ id:made.id, week_start:made.week_start } };
  const { data: again } = await admin.from('weekly_cycles')
    .select('id,week_start').eq('week_start', week_start).single();
  if(again) return { ok:true, cycle:{ id:again.id, week_start:again.week_start } };
  return { ok:false, error:'cycle_failed', detail: error && error.message };
}
// ── THE SUBMISSION WINDOW ────────────────────────────────────────
// Each role band gets its own slot in the week, and the slots run one after
// the other: the people doing the selling file first, then their leaders,
// then the managers. Nothing here is scheduled - the window is worked out by
// comparing the Dublin clock to the cycle on every request, so there is no
// cron to drift, nothing to back-fill, and a deploy cannot miss a deadline.
//
// The UTC instant of a Dublin wall-clock time. Dublin is UTC in winter and
// UTC+1 in summer, so Date.UTC() alone is an hour out for half the year.
// Guess, read the real offset AT that guess, then correct. The four window
// times are 10:00, 11:00, 15:00 and 16:30 - none of them anywhere near the
// 01:00-02:00 changeover, so the guess is never in the ambiguous hour and
// one correction is enough.
function dublinOffsetMinutes(at){
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Dublin',
    timeZoneName:'shortOffset' }).formatToParts(at);
  const tz = (parts.find(p=>p.type==='timeZoneName')||{}).value || 'GMT';
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if(!m) return 0;                                   // plain 'GMT' is +00:00
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2])*60 + Number(m[3]||0));
}
function dublinInstant(ymd, hh, mm){
  const [y,mo,d] = String(ymd).split('-').map(Number);
  const guess = Date.UTC(y, mo-1, d, hh, mm, 0, 0);
  const off = dublinOffsetMinutes(new Date(guess));
  return new Date(guess - off*60000);
}
// Monday + n days, as a YYYY-MM-DD date string. Adding whole days to the
// DATE rather than to an instant, for the same reason mondayOfWeek does.
function dayOfWeekStart(week_start, n){
  const [y,m,d] = String(week_start).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d, 12, 0, 0) + n*86400000);
  return [dt.getUTCFullYear(),
          String(dt.getUTCMonth()+1).padStart(2,'0'),
          String(dt.getUTCDate()).padStart(2,'0')].join('-');
}
// The four boundaries of a cycle, as instants.
function cycleWindows(cycle){
  const ws = cycle && cycle.week_start;
  const wed = dayOfWeekStart(ws, 2), thu = dayOfWeekStart(ws, 3), fri = dayOfWeekStart(ws, 4);
  return {
    ic_open:       dublinInstant(wed, 10, 0),
    ic_close:      dublinInstant(thu, 15, 0),
    leader_close:  dublinInstant(thu, 16, 30),
    manager_close: dublinInstant(fri, 11, 0)
  };
}
// Which slot a role files in. senior_exec has none - it reads the company
// and writes nothing, here as everywhere else.
function bandOf(role){
  if(role === 'agent' || role === 'specialist' || role === 'executive') return 'ic';
  if(role === 'leader' || role === 'supervisor') return 'leader';
  if(role === 'manager') return 'manager';
  if(role === 'director' || role === 'admin') return 'override';
  return null;
}
// Which slot the week is in right now.
function openBandNow(cycle, now){
  const w = cycleWindows(cycle);
  const t = now.getTime();
  if(t < w.ic_open.getTime()) return 'pre';
  if(t < w.ic_close.getTime()) return 'ic';
  if(t < w.leader_close.getTime()) return 'leader';
  if(t < w.manager_close.getTime()) return 'manager';
  return 'closed';
}
// The one place the weekly clock is read. A test can pin it through
// __setWeekClock below; nothing else can. It is NOT read from the
// environment or from a request, so it cannot be switched on by
// configuration, a header or a payload - only by code that has already
// require()d this module, which by then owns the process anyway.
let __weekClock = null;
function weekNow(){ return __weekClock || new Date(); }
function canWriteNow(me, cycle, now){
  const band = bandOf(me && me.role);
  if(band === 'override') return true;               // director and admin, any time
  if(!band) return false;                            // senior_exec, never
  return openBandNow(cycle, now) === band;
}
// When a given band opens and closes, as instants.
function bandBounds(band, cycle){
  const w = cycleWindows(cycle);
  if(band === 'ic')      return { opens: w.ic_open,      closes: w.ic_close };
  if(band === 'leader')  return { opens: w.ic_close,     closes: w.leader_close };
  if(band === 'manager') return { opens: w.leader_close, closes: w.manager_close };
  return { opens: null, closes: null };
}
const BAND_WORD = { ic:'Wednesday 10:00', leader:'Thursday 15:00', manager:'Thursday 16:30' };
// Everything the banner needs, worked out once on the server so the client
// never has to do timezone arithmetic of its own.
function weekWindowInfo(me, cycle, now){
  const my_band = bandOf(me && me.role);
  const open_band = openBandNow(cycle, now);
  const b = bandBounds(my_band, cycle);
  const can = canWriteNow(me, cycle, now);
  let stage_label;
  if(my_band === 'override') stage_label = 'You can edit at any time';
  else if(!my_band) stage_label = 'You have view-only access';
  else if(can) stage_label = 'Your window is open';
  else if(now.getTime() < b.opens.getTime()) stage_label = 'Opens ' + BAND_WORD[my_band];
  else stage_label = 'Closed for this week';
  return {
    open_band, my_band, can_write_now: can,
    my_opens_at:  b.opens  ? b.opens.toISOString()  : null,
    my_closes_at: b.closes ? b.closes.toISOString() : null,
    stage_label
  };
}
// Who a weekly write is for. Absent or self means the caller, exactly as in
// part 1. A different person has to pass canActOn - the same predicate every
// other write gate uses, which is subtree AND outranks for a local leader and
// is false outright for the read-only company-wide tier.
async function weekTargetFor(me, raw){
  if(raw === undefined || raw === null || raw === '' || String(raw) === String(me.id))
    return { ok:true, user_id: me.id, self:true };
  const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id', raw).single();
  if(!tgt) return { ok:false, status:404, error:'not_found' };
  if(!(await canActOn(me, tgt))) return { ok:false, status:403, error:'out_of_scope' };
  return { ok:true, user_id: tgt.id, self:false };
}
// Money: a finite number at or above zero. Blank counts as zero, because an
// untouched field on the form is not an error.
function weekAmount(v){
  if(v===null || v===undefined || v==='') return 0;
  // A number or a numeric string, and nothing else. Number([5]) is 5 and
  // Number(true) is 1, so an array or a boolean would otherwise be coerced
  // into money nobody typed.
  if(typeof v !== 'number' && typeof v !== 'string') return false;
  const n = Number(v);
  return (Number.isFinite(n) && n >= 0) ? n : false;
}
// Counts: the same, but whole. Half a lead is not a lead.
function weekCount(v){
  if(v===null || v===undefined || v==='') return 0;
  if(typeof v !== 'number' && typeof v !== 'string') return false;
  const n = Number(v);
  return (Number.isInteger(n) && n >= 0) ? n : false;
}
function numOrNull(v){
  if(v===null || v===undefined || v==='') return null;
  const n = Number(v);
  return (Number.isFinite(n) && n>=0) ? n : false;
}
// null / '' clears; anything outside the three campuses returns false so callers can 400.
function validCampus(v){
  if(v===null || v===undefined || v==='') return null;
  const c = String(v).toLowerCase();
  return ['dublin','limerick','both'].includes(c) ? c : false;
}
// Teams a caller can see figures for: the company-wide tiers (director, admin
// and the read-only viewer) see all; a local leader sees the teams led from
// inside their branch, plus the teams their branch's people sit on. Two
// widenings against the old supervisor rule, both deliberate: the membership
// test walks the whole subtree rather than direct reports only, so it agrees
// with every other gate; and the leader test accepts any leader inside the
// branch, not just the caller, so a manager is not locked out of a team run by
// their own supervisor. This is what the client's teamsOverseenBy already said.
async function accessibleTeamIds(me, allTeams, allProfs){
  if(seesWholeCompany(me.role)) return allTeams.map(t=>t.id);
  if(isLocalLeader(me.role)){
    const sub = await subtreeIds(me);
    const branch = new Set([me.id, ...sub]);
    const mine = new Set();
    allTeams.forEach(t => { if(t.leader_id!=null && branch.has(t.leader_id)) mine.add(t.id); });
    allProfs.forEach(u => {
      if(u.team_id!=null && branch.has(u.id)) mine.add(u.team_id);
    });
    return [...mine];
  }
  return [];
}
// ── CHAT MEMBERSHIP ──────────────────────────────────────────────
// RLS lets the browser READ messages it may see (is_thread_member) and nothing
// else; every write comes through here. These helpers mirror is_thread_member
// EXACTLY, and deliberately NOT accessibleTeamIds: that one hands a manager or
// director every team, which is right for figures but wrong here - the gateway
// must never accept a send into a thread whose rows RLS will then hide from the
// sender, because nothing is echoed locally and their own message would vanish.
const MSG_MAX = 4000;
const MSG_PAGE = 50;
// The teams whose group chat this caller belongs to: the team they are on,
// plus any team they lead. teams.active is ignored on purpose - deactivating a
// team hides it from pickers, it does not evict its people from the chat.
async function chatTeamIdsOf(me){
  const { data: allTeams } = await admin.from('teams').select('id,name,leader_id');
  const teams = allTeams || [];
  const mine = new Set();
  if(me.team_id != null && teams.some(t => t.id === me.team_id)) mine.add(me.team_id);
  teams.forEach(t => { if(t.leader_id === me.id) mine.add(t.id); });
  return { ids: [...mine], teams };
}
async function memberOfThread(me, thread){
  if(!thread) return false;
  if(thread.kind === 'dm') return thread.user_a === me.id || thread.user_b === me.id;
  if(thread.kind === 'group'){
    if(thread.team_id == null) return false;
    const { ids } = await chatTeamIdsOf(me);
    return ids.includes(thread.team_id);
  }
  return false;
}
// A DM thread is keyed by the sorted pair, so the two directions can never
// produce two threads.
function dmPair(a, b){ return [String(a), String(b)].sort(); }
async function findOrCreateDm(meId, otherId){
  const [user_a, user_b] = dmPair(meId, otherId);
  const { data: existing } = await admin.from('threads')
    .select('*').eq('kind','dm').eq('user_a',user_a).eq('user_b',user_b).single();
  if(existing) return existing;
  const { data: created } = await admin.from('threads')
    .insert({ kind:'dm', user_a, user_b }).select('*').single();
  if(created) return created;
  // unique(user_a,user_b) turns a race into a duplicate key, so re-read.
  const { data: raced } = await admin.from('threads')
    .select('*').eq('kind','dm').eq('user_a',user_a).eq('user_b',user_b).single();
  return raced || null;
}
async function findOrCreateGroup(teamId){
  const { data: existing } = await admin.from('threads')
    .select('*').eq('kind','group').eq('team_id',teamId).single();
  if(existing) return existing;
  const { data: created } = await admin.from('threads')
    .insert({ kind:'group', team_id:teamId }).select('*').single();
  if(created) return created;
  const { data: raced } = await admin.from('threads')
    .select('*').eq('kind','group').eq('team_id',teamId).single();
  return raced || null;
}

// Everyone below this person in the reports_to chain, transitively.
async function subtreeIds(me){
  const { data: all } = await admin.from('profiles').select('id,reports_to');
  const rows = all || [];
  const out = new Set();
  let frontier = [me.id];
  while(frontier.length){
    const next = [];
    const f = new Set(frontier);
    rows.forEach(u => {
      if(u.reports_to!=null && f.has(u.reports_to) && !out.has(u.id) && u.id!==me.id){
        out.add(u.id); next.push(u.id);
      }
    });
    frontier = next;
  }
  return out;
}
// Who may edit whose descriptive profile fields.
async function canEditProfileOf(me, tgt){
  if(!me || !tgt) return false;
  if(me.id === tgt.id) return true;
  return canActOn(me, tgt);
}
// Viewing used to be the same set as editing. It no longer is: a company-wide
// viewer reads every profile and edits none of them.
async function canViewProfileOf(me, tgt){
  // Viewing and editing were the same predicate until a read-only tier
  // existed. They are not the same question any more.
  if(me && seesEverything(me.role)) return true;
  return canEditProfileOf(me, tgt);
}
// All the profile gates in one place, computed from a single subtree walk.
//   view      : self, up the chain, or a company-wide viewer
//   edit      : self, or up the chain - never a viewer
//   certs     : view follows canView; managing is chain only, and below
//               director tier you cannot manage your own
//   appraisals: chain only, never about yourself, not at any tier
//   documents : chain only - below director tier you cannot see your own
async function gatesFor(me, tgt){
  const self = me.id === tgt.id;
  // Read-only breadth. Deliberately absent from canEdit, certManage,
  // appraisal and doc: this tier changes nothing and sees no private HR file.
  const viewAll = seesEverything(me.role);
  // "Up the chain" is now the same predicate as every write gate, so a manager
  // who cannot edit a profile cannot see its HR file either.
  const chain = await canActOn(me, tgt);
  // Certs, appraisals and documents are set FOR you, not BY you. The one
  // exception is the top of the tree, because nobody sits above them to do it.
  const chefia = chain && !(self && rank(me.role) < ROLE_RANK.director);
  return {
    canView: self || chain || viewAll,
    canEdit: self || chain,
    certView: self || chain || viewAll,
    certManage: chefia,
    appraisal: !self && chain,
    doc: chefia
  };
}
// ── meetings ────────────────────────────────────────────────────
const MEETING_EDITABLE = ['title','meeting_date','meeting_time','duration','type','location','notes','minutes_private'];
// A room name nobody can guess; it is the only thing protecting the call.
function newJitsiRoom(){ return 'nedhub-' + require('crypto').randomUUID().replace(/-/g,''); }
// Resolve a chosen location, or fail loudly rather than silently dropping it.
async function resolveLocation(locationId){
  if(locationId===null || locationId===undefined || locationId==='') return { ok:true, id:null };
  const { data } = await admin.from('locations').select('id,active').eq('id',locationId).single();
  if(!data) return { ok:false, error:'location_not_found' };
  if(data.active === false) return { ok:false, error:'location_inactive' };
  return { ok:true, id:data.id };
}
// The organiser runs their own meeting; director tier and above can step in.
function canManageMeeting(me, meeting){
  return meeting.created_by === me.id || rank(me.role) >= ROLE_RANK.director;
}
// A meeting's attendee ids, creator always included.
async function attendeeIdsOf(meetingId, createdBy){
  const { data } = await admin.from('meeting_attendees').select('user_id').eq('meeting_id', meetingId);
  const ids = (data||[]).map(a=>a.user_id);
  if(createdBy && !ids.includes(createdBy)) ids.unshift(createdBy);
  return ids;
}
// Built field by field so private minutes can never ride along in the payload.
function meetingForCaller(m, attendees, me, locationsById){
  const isCreator = m.created_by === me.id;
  const isAttendee = attendees.includes(me.id);
  const minutesVisible = m.minutes_private ? isCreator : (isCreator || isAttendee);
  const out = {
    id: m.id, title: m.title, meeting_date: m.meeting_date, meeting_time: m.meeting_time,
    duration: m.duration, type: m.type, location: m.location, notes: m.notes,
    location_id: (m.location_id!=null) ? m.location_id : null,
    location_name: (m.location_id!=null && locationsById && locationsById[m.location_id])
      ? locationsById[m.location_id] : null,
    is_online: !!m.is_online,
    // The room name is the join key, so every attendee needs it.
    jitsi_room: m.is_online ? (m.jitsi_room || null) : null,
    minutes_private: !!m.minutes_private, created_by: m.created_by, attendees,
    can_edit: canManageMeeting(me, m),
    minutes_visible: minutesVisible,
    minutes_editable: isCreator,
    has_minutes: !!(m.minutes && String(m.minutes).trim())
  };
  if(minutesVisible) out.minutes = m.minutes || '';
  return out;
}
const DOC_CATEGORIES = ['Contract','Certificate','Appraisal','Training','ID','Other'];
// ── CONTENT LIBRARY ──────────────────────────────────────────────
// Four kinds of item share one table and one pair of gates: Manager and up
// manage, anyone signed in reads. Two buckets, and the split matters:
// content-covers is PUBLIC because a cover is decoration, content-files is
// PRIVATE and only ever reaches a browser as a signed URL that expires.
// 'update' is a news item: same table, same gates, same upload. It differs
// only in how it is ordered (pinned first, newest first) and in needing
// nothing but a title - a text-only announcement is a valid item.
const CONTENT_TYPES = ['training','course','material','tool','update'];
const CONTENT_BUCKETS = { cover:'content-covers', file:'content-files' };
// A cover is stored as its public URL, because that is what a page needs. To
// delete the object later the path has to be recovered from it; anything that
// is not recognisably this bucket's public URL is left alone rather than
// guessed at, so a hand-edited row can never make us remove the wrong object.
function coverObjectPath(url){
  const m = String(url||'').match(/\/storage\/v1\/object\/public\/content-covers\/([^?]+)/);
  if(!m) return null;
  try { return decodeURIComponent(m[1]); } catch(e){ return m[1]; }
}
function safeFileName(n){
  return String(n||'file').replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,80) || 'file';
}
// A link that is safe to hand back to a browser as an href: http(s) only,
// so a stored 'javascript:'/'data:' URL can never become an XSS when the
// card is clicked. Returns a trimmed URL or null.
function safeHttpUrl(v){
  if(typeof v !== 'string') return null;
  const s = v.trim();
  if(!s) return null;
  if(s.length > 2000) return null;
  if(!/^https?:\/\//i.test(s)) return null;
  return s;
}
// ── TRAINING TESTS ───────────────────────────────────────────────
// Only type='training' carries a test. has_test and pass_threshold are owned
// EXCLUSIVELY by save_training_test, which refuses every other type, so a
// course, material or tool cannot acquire a test through any client or any
// other action - create_content writes them false/null and update_content
// never touches them.
//
// THE RULE THAT MATTERS: correct_index appears in exactly one response on this
// whole gateway - get_training_admin, behind isMgr. Every test-taker payload
// is built field by field and never selects the column at all, so there is no
// projection to forget to prune and nothing to delete after the fact. Exactly
// the discipline file_path lives under in get_content.
const TEST_MIN_OPTIONS = 2, TEST_MAX_OPTIONS = 6, TEST_MAX_QUESTIONS = 100;
const CERT_MINT_TRIES = 6;
// Validate the whole set before writing anything: a half-replaced question
// list is worse than a rejected save.
function validateQuestions(list){
  if(!Array.isArray(list) || !list.length) return { ok:false, error:'no_questions' };
  if(list.length > TEST_MAX_QUESTIONS) return { ok:false, error:'too_many_questions' };
  const out = [];
  for(let i=0;i<list.length;i++){
    const q = list[i] || {};
    const text = (q.question===undefined||q.question===null) ? '' : String(q.question).trim();
    if(!text) return { ok:false, error:'missing_question' };
    if(!Array.isArray(q.options)) return { ok:false, error:'bad_options' };
    const options = q.options.map(o => (o===undefined||o===null) ? '' : String(o).trim());
    if(options.length < TEST_MIN_OPTIONS || options.length > TEST_MAX_OPTIONS) return { ok:false, error:'bad_options' };
    if(options.some(o => !o)) return { ok:false, error:'bad_options' };
    const ci = Number(q.correct_index);
    if(!Number.isInteger(ci) || ci < 0 || ci >= options.length) return { ok:false, error:'bad_correct_index' };
    out.push({ question:text, options, correct_index:ci, sort_order:i });
  }
  return { ok:true, value:out };
}
// 'TRN-<year>-0001', counting only this year's certificates so the series
// restarts each January. Not atomic, which is why the caller retries on the
// unique violation rather than trusting the count it just read.
function certNumberFor(year, taken){
  const prefix = 'TRN-' + year + '-';
  let n = 0;
  taken.forEach(c => { if(String(c||'').indexOf(prefix) === 0) n++; });
  let candidate = prefix + String(n+1).padStart(4,'0');
  const set = new Set(taken.map(String));
  // A gap in the series (a deleted completion) must not re-issue a live
  // number, so walk forward past anything already taken.
  let guard = 0;
  while(set.has(candidate) && guard++ < 10000){
    n++;
    candidate = prefix + String(n+1).padStart(4,'0');
  }
  return candidate;
}
// One person's standing on one training: how many attempts, their best score,
// and the completion if they ever passed. Built field by field - the attempt
// rows hold the answers they gave and none of that is anybody's business but
// the grader's.
async function myTrainingStatus(userId, contentId){
  const { data: att } = await admin.from('training_attempts')
    .select('id,score,passed,created_at').eq('user_id',userId).eq('content_id',contentId);
  let best = null, everPassed = false, last = null;
  (att||[]).forEach(a => {
    const sc = Number(a.score);
    if(Number.isFinite(sc) && (best === null || sc > best)) best = sc;
    if(a.passed) everPassed = true;
    if(!last || String(a.created_at||'') > String(last)) last = a.created_at || null;
  });
  const { data: done } = await admin.from('training_completions')
    .select('id,cert_number,score,completed_at').eq('user_id',userId).eq('content_id',contentId).single();
  return {
    attempts: (att||[]).length,
    best_score: best,
    last_attempt_at: last,
    passed: everPassed || !!done,
    completion_id: done ? done.id : null,
    cert_number: done ? done.cert_number : null,
    completed_at: done ? done.completed_at : null
  };
}
// A training row, confirmed to be a training. Used by every action below so
// the type gate is written once.
async function trainingRow(id){
  const { data: row } = await admin.from('content_items')
    .select('id,type,title,has_test,pass_threshold').eq('id',id).single();
  if(!row) return { ok:false, status:404, error:'not_found' };
  if(row.type !== 'training') return { ok:false, status:400, error:'not_a_training' };
  return { ok:true, row };
}
// job_title stays here so an old client cannot be broken by its removal, but
// nothing sends it any more: the profile derives the job title from the cargo.
const PROFILE_EDITABLE = ['first','last','nickname','job_title','phone','instagram','linkedin','nationality','language','bio'];
// languages is text[] and the birthday parts are integers, so none of them can
// go through the generic string path above - it would hand Postgres a string
// for an array column and '' for an int. Each gets its own validated branch,
// shaped like start_date's but WITHOUT the chefia gate: these are personal
// details, self-editable exactly like bio and phone.
const LANGUAGES_MAX = 30;      // one person, not a dictionary
const LANGUAGE_MAX_LEN = 50;
// Returns {ok:true, value:[...]} or {ok:false, error}.
function normLanguages(v){
  if(v===null || v===undefined) return { ok:true, value:[] };
  if(!Array.isArray(v)) return { ok:false, error:'bad_languages' };
  const cleaned = [];
  for(const raw of v){
    const t = (raw===null || raw===undefined) ? '' : String(raw).trim();
    if(t === '') continue;                       // blanks are dropped, not stored
    if(t.length > LANGUAGE_MAX_LEN) return { ok:false, error:'bad_languages' };
    if(!cleaned.includes(t)) cleaned.push(t);    // a tick list cannot hold duplicates
  }
  if(cleaned.length > LANGUAGES_MAX) return { ok:false, error:'too_many_languages' };
  return { ok:true, value: cleaned };
}
// day 1-31 / month 1-12, or null. Deliberately no year and no calendar check:
// a birthday here is a day and a month, so 31 February is storable and
// harmless rather than a validation argument.
const BIRTH_RANGE = { birth_day:[1,31], birth_month:[1,12] };
function normBirthPart(k, v){
  if(v===null || v===undefined) return { ok:true, value:null };
  // Number([14]) is 14 and Number(true) is 1, so the type is checked before
  // any coercion - only a number or a numeric string may become a birthday.
  if(typeof v !== 'number' && typeof v !== 'string') return { ok:false };
  if(String(v).trim()==='') return { ok:true, value:null };
  const n = Number(v);
  if(!Number.isInteger(n)) return { ok:false };
  const [lo,hi] = BIRTH_RANGE[k];
  if(n < lo || n > hi) return { ok:false };
  return { ok:true, value:n };
}
// start_date is a date column, so it is validated on its own rather than
// joining PROFILE_EDITABLE, whose generic path would send '' to Postgres.
// Returns {ok:true, value:null|'YYYY-MM-DD'} or {ok:false}.
function normStartDate(v){
  if(v===null || v===undefined || String(v).trim()==='') return { ok:true, value:null };
  const t = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if(!m) return { ok:false };
  const d = new Date(t + 'T00:00:00Z');
  if(Number.isNaN(d.getTime())) return { ok:false };
  // Reject a well-formed-but-impossible date such as 2026-02-31.
  if(d.getUTCFullYear()!==Number(m[1]) || d.getUTCMonth()+1!==Number(m[2]) || d.getUTCDate()!==Number(m[3]))
    return { ok:false };
  return { ok:true, value:t };
}
// Who may set someone's start date: anyone already cleared to edit that
// profile, as long as it is not their own - a person does not decide when they
// joined. Director tier and above editing themselves is the documented
// exception, since nobody sits above them to do it. The client mirrors this.
function allowStart(me, targetId){
  return String(me.id) !== String(targetId) || rank(me.role) >= ROLE_RANK.director;
}
// Copied verbatim from the client's CERT_LIST.
const CERT_SEED = [
  'NED College - Organisational Overview',
  'Sales Process - NED Limerick',
  'Sales Process - NED Dublin',
  'Understanding the Sales Funnel',
  'Sales Communication Skills',
  'Agency Management and B2B Partnerships',
  'Customer Service and Student Experience',
  'Consultative Selling Techniques',
  'WhatsApp-First Sales Strategy',
  'Post-Sales Support and Retention',
  'Handling Objections and Closing',
  'Irish Education Market and NED Products',
];
async function accessibleIds(me){
  const { data: all } = await admin.from('profiles').select('id,role,reports_to');
  // A pure viewer reads everyone, including the tiers above them - there is no
  // authority attached to the set, so outranks() does not apply.
  if(seesEverything(me.role)) return all.map(u=>u.id);
  if(seesWholeCompany(me.role)) return all.filter(u=>outranks(me.role, u.role)).map(u=>u.id);
  // A local leader reads their own branch, transitively, plus themselves. No
  // rank filter: a report never outranks the person they report to, and when a
  // cargo change makes them equal they are still that person's to manage.
  if(isLocalLeader(me.role)){
    const sub = await subtreeIds(me);
    const ids = all.filter(u=>sub.has(u.id)).map(u=>u.id); ids.push(me.id); return ids;
  }
  return [me.id];
}
// Pure, side-effect-free window maths, exported so it can be asserted
// directly. Nothing in the request path reads this object; it exists so the
// DST boundaries can be tested without putting a clock override into
// production code, which is the only other way to make them deterministic.
exports.__week = { dublinInstant, dayOfWeekStart, cycleWindows, bandOf,
  openBandNow, canWriteNow, bandBounds, weekWindowInfo };
// Pin or release the weekly clock. Tests only - see weekNow().
exports.__setWeekClock = (d) => { __weekClock = (d instanceof Date) ? d : null; };

// ── HOLIDAYS / TIME OFF ──────────────────────────────────────────
// Four kinds of leave, one of which costs days. Sick, unpaid and other are
// recorded so a manager can see them, and are deliberately invisible to the
// balance arithmetic - only 'annual' is deducted.
const HOLIDAY_TYPES = ['annual','sick','unpaid','other'];
const DEFAULT_ALLOWANCE = 20;
// The leave year is the calendar year, read in Dublin: a request made at
// 23:30 on 31 December belongs to the year the office is in, not UTC's.
function holidayYear(now){ return Number(dublinYMD(now || new Date()).slice(0,4)); }

// A holiday date is a DATE, not an instant: the 3rd is the 3rd in every time
// zone. Parsed and validated by hand so 2026-02-31, which Date.UTC would
// silently roll into March, is refused instead of counted.
function ymdParts(v){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if(!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if(mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if(back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return { y, mo, d, t };
}
// Working days, Monday to Friday, both ends included. Returns false for a
// span that cannot be counted at all (unparseable, backwards, or absurdly
// long) and 0 for a real span that happens to hold no weekday - a Saturday
// to Sunday request. The caller treats those differently: one is a broken
// payload, the other is a request worth nothing.
function workingDays(start, end){
  const a = ymdParts(start), b = ymdParts(end);
  if(!a || !b) return false;
  if(a.t > b.t) return false;
  const span = Math.round((b.t - a.t) / 86400000) + 1;
  if(span > 366) return false;
  let n = 0;
  for(let i = 0; i < span; i++){
    const wd = new Date(a.t + i * 86400000).getUTCDay();   // 0 Sun ... 6 Sat
    if(wd !== 0 && wd !== 6) n++;
  }
  return n;
}
// Number or numeric string ONLY. Number([5]) is 5 and Number(true) is 1, so
// an array or a boolean must never reach the arithmetic. Unlike numOrNull
// this accepts negatives, because an adjustment of -3 days is the point.
function holidayNum(v){
  if(typeof v === 'number') return Number.isFinite(v) ? v : false;
  if(typeof v === 'string' && v.trim() !== ''){
    const n = Number(v);
    return Number.isFinite(n) ? n : false;
  }
  return false;
}

// Balances for a whole list of people in three queries rather than three per
// person: an inbox of thirty would otherwise be ninety round trips. There is
// exactly one implementation of the arithmetic - holidayBalance() below is
// this function with a list of one - so the single and the batch can never
// drift apart.
async function holidayBalances(userIds, year){
  const y = Number(year);
  const ids = Array.from(new Set((userIds || []).map(String)));
  const out = {};
  ids.forEach(id => { out[id] = { allowance: DEFAULT_ALLOWANCE,
    adjustments_total: 0, used: 0, remaining: DEFAULT_ALLOWANCE }; });
  if(!ids.length) return out;
  // No row means the default, not zero: nobody has to be seeded before the
  // feature works.
  const { data: allowRows } = await admin.from('holiday_allowances')
    .select('user_id,days').eq('year', y).in('user_id', ids);
  (allowRows || []).forEach(r => {
    const n = holidayNum(r.days), k = String(r.user_id);
    if(out[k] && n !== false) out[k].allowance = n;
  });
  const { data: adjRows } = await admin.from('holiday_adjustments')
    .select('user_id,delta').eq('year', y).in('user_id', ids);
  (adjRows || []).forEach(r => {
    const n = holidayNum(r.delta), k = String(r.user_id);
    if(out[k] && n !== false) out[k].adjustments_total += n;
  });
  // Only approved annual leave is spent. A pending request reserves nothing,
  // so two people cannot both be told they have the last day.
  const { data: reqRows } = await admin.from('holiday_requests')
    .select('user_id,working_days,start_date').eq('type','annual').eq('status','approved')
    .in('user_id', ids);
  (reqRows || []).forEach(r => {
    // A request belongs to the year it STARTS in, so one that crosses New
    // Year comes out of one balance rather than being split across two.
    if(String(r.start_date || '').slice(0,4) !== String(y)) return;
    const n = holidayNum(r.working_days), k = String(r.user_id);
    if(out[k] && n !== false) out[k].used += n;
  });
  ids.forEach(id => { const b = out[id];
    b.remaining = b.allowance + b.adjustments_total - b.used; });
  return out;
}
async function holidayBalance(user_id, year){
  const m = await holidayBalances([user_id], year);
  return m[String(user_id)];
}
// One request, built field by field. Nothing from the row reaches the client
// except these, so a column added to the table later cannot leak by being
// picked up in a projection.
function holidayRequestOut(r){
  return { id: r.id, type: r.type, start_date: r.start_date, end_date: r.end_date,
    working_days: Number(r.working_days || 0), note: r.note || '', status: r.status,
    decided_at: r.decided_at || null, decision_note: r.decision_note || '',
    created_at: r.created_at || null };
}
// Pending first, then everything decided, newest first within each group.
function holidaySort(rows){
  const key = r => String(r.created_at || '') + '|' + String(r.id);
  return rows.slice().sort((a,b) => {
    const pa = a.status === 'pending' ? 0 : 1, pb = b.status === 'pending' ? 0 : 1;
    if(pa !== pb) return pa - pb;
    return key(b).localeCompare(key(a));
  });
}
// The gate for every holiday write that lands on somebody else: the ordinary
// Manager = LOCAL question. NOT seesWholeCompany, which would let senior_exec
// - a rank-0 read-only tier - set everyone's allowance.
// The admin line is deliberate belt and braces, and today it is redundant:
// canActOn already admits an admin through its director-or-above branch, so
// removing it changes no behaviour and no test. It is written down because
// seeding every balance in the company is an ADMIN job, and a later
// tightening of canActOn must not take that away by accident.
async function mayManageHolidays(me, tgt){
  if(rank(me.role) >= ROLE_RANK.admin) return true;
  return canActOn(me, tgt);
}
// Pure date maths, exported so the weekday counting can be asserted directly
// rather than only through an action.
exports.__holidays = { workingDays, ymdParts, holidayNum, holidaySort, HOLIDAY_TYPES, DEFAULT_ALLOWANCE };

// ── COMPETITIONS: THE SALES RANKING ──────────────────────────────
// The figures live in a Google Sheet the sales team already keeps by hand.
// It is shared "anyone with the link", so this reads it with no credentials
// at all - no service account, no OAuth, nothing to rotate. The sheet is the
// source of truth; nothing here writes back to it.
const COMP_MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];
const COMP_CACHE_MS = 5 * 60 * 1000;
const COMP_DEFAULT_SOURCE = { sheet_id:'', dublin_tab:'', limerick_tab:'' };

async function competitionSource(){
  const { data } = await admin.from('competition_source')
    .select('id,sheet_id,dublin_tab,limerick_tab').eq('id', 1).single();
  if(!data) return Object.assign({ id:1 }, COMP_DEFAULT_SOURCE);
  return { id: data.id,
    sheet_id: String(data.sheet_id || ''),
    dublin_tab: String(data.dublin_tab || ''),
    limerick_tab: String(data.limerick_tab || '') };
}

// Every agent in the sheet carries a campus suffix: "Alice Almeida -D". It is
// bookkeeping for whoever maintains the sheet, never part of the person's
// name, so it comes off before anything - display, matching, sorting.
function cleanAgent(name){
  return String(name == null ? '' : name).replace(/\s*-\s*[DL]\s*$/i, '').trim();
}
// "€14,000" -> 14000. The commas are thousands separators, the euro sign and
// any stray spaces are decoration, and anything that is not a number at the
// end of all that is "no target" rather than zero - an agent without a target
// cannot be measured against one.
function parseEuro(v){
  if(v === null || v === undefined) return null;
  const raw = String(v).replace(/ /g, ' ').trim();
  if(!raw) return null;
  const cleaned = raw.replace(/[€$£\s]/g, '').replace(/,/g, '');
  if(!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
// A monthly cell. Blank or unreadable is 0 - a month somebody sold nothing in
// is a real zero, not a gap - and decimals survive.
function parseCell(v){
  const n = parseEuro(v);
  return n === null ? 0 : n;
}
// A real CSV reader, not a split on commas: the Target column arrives as
// "€14,000", quoted precisely because it contains one. Doubled quotes inside
// a quoted field are an escaped quote, and a field may span newlines.
function parseCsv(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text == null ? '' : text);
  for(let i = 0; i < src.length; i++){
    const c = src[i];
    if(inQuotes){
      if(c === '"'){
        if(src[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if(c === '"'){ inQuotes = true; continue; }
    if(c === ','){ row.push(field); field = ''; continue; }
    if(c === '\r'){ continue; }
    if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if(field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows;
}
// Turn a sheet tab into agent rows. Columns are found by their HEADING, not
// by position, so a column inserted in the sheet does not silently shift the
// whole year's figures by one month.
function parseCompetitionCsv(text, campus){
  const rows = parseCsv(text);
  if(!rows.length) return { error:'empty' };
  const head = rows[0].map(h => String(h == null ? '' : h).trim().toLowerCase());
  const idxOf = (name) => head.indexOf(String(name).toLowerCase());
  const agentIdx = idxOf('agent');
  if(agentIdx < 0) return { error:'no_agent_column' };
  const teamIdx = idxOf('team');
  const targetIdx = idxOf('target');
  // A month matches its full name or its first three letters, so "Jan" and
  // "January" are the same column.
  const monthIdx = COMP_MONTHS.map(m => {
    let i = idxOf(m);
    if(i < 0) i = head.indexOf(m.slice(0,3).toLowerCase());
    return i;
  });
  const out = [];
  for(let r = 1; r < rows.length; r++){
    const cells = rows[r];
    const agent = cleanAgent(cells[agentIdx]);
    if(!agent) continue;                    // trailing blank rows, and there are many
    out.push({
      agent,
      team: teamIdx >= 0 ? String(cells[teamIdx] == null ? '' : cells[teamIdx]).trim() : '',
      campus,
      months: monthIdx.map(i => i >= 0 ? parseCell(cells[i]) : 0),
      target: targetIdx >= 0 ? parseEuro(cells[targetIdx]) : null,
    });
  }
  return { rows: out };
}

// The network, behind a seam. Tests replace it with a fixture; production
// uses the runtime's own fetch (Node 18+, and this function runs on 22).
let __compFetch = null;
function compFetch(url){
  if(__compFetch) return __compFetch(url);
  if(typeof fetch !== 'function') return Promise.reject(new Error('no fetch in this runtime'));
  return fetch(url);
}
const __compCache = new Map();
function compCacheKey(sheetId, tab){ return sheetId + '|' + tab; }
function competitionUrl(sheetId, tab){
  return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(sheetId) +
    '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(tab);
}
// Never throws. A sheet that is unreachable, renamed, unshared or malformed
// is a state the page knows how to show; an exception here would be a 500 on
// a screen that is only ever decorative.
async function fetchTab(sheetId, tab, campus, now){
  if(!sheetId || !tab) return { error:'not_configured' };
  const at = (now instanceof Date ? now : new Date()).getTime();
  const key = compCacheKey(sheetId, tab);
  const hit = __compCache.get(key);
  if(hit && (at - hit.at) < COMP_CACHE_MS) return { rows: hit.rows, cached:true };
  let text;
  try {
    const res = await compFetch(competitionUrl(sheetId, tab));
    if(!res || !res.ok) return { error:'fetch_failed', status: res ? res.status : 0 };
    text = await res.text();
  } catch(e){
    return { error:'fetch_failed', detail: String(e && e.message || e) };
  }
  const parsed = parseCompetitionCsv(text, campus);
  if(parsed.error) return { error: parsed.error };
  __compCache.set(key, { at, rows: parsed.rows });
  return { rows: parsed.rows };
}
async function loadCompetition(src, now){
  const d = await fetchTab(src.sheet_id, src.dublin_tab, 'dublin', now);
  if(d.error) return { error:'sheet_unavailable', detail:d.error };
  const l = await fetchTab(src.sheet_id, src.limerick_tab, 'limerick', now);
  if(l.error) return { error:'sheet_unavailable', detail:l.error };
  return { rows: d.rows.concat(l.rows) };
}

// Who is top, and on what. Two different questions: the biggest number, and
// the biggest number RELATIVE to what that person was asked for - which is
// why a small target with a big overshoot can win the second and not the
// first. A month nobody sold anything in has no winner at all; crowning a
// zero would be worse than crowning nobody.
function competitionWinner(rows, monthIdx, kind){
  let best = null, bestKey = 0;
  (rows || []).forEach(r => {
    const value = Number((r.months || [])[monthIdx] || 0);
    let key;
    if(kind === 'star'){
      if(!(Number(r.target) > 0)) return;   // nothing to be measured against
      key = value / Number(r.target);
    } else {
      key = value;
    }
    // ONE rule for "does this person qualify at all", and it is the figure
    // the prize is actually awarded on. A separate value > 0 guard above
    // would be redundant - for either prize a zero month gives a zero key -
    // and a redundant guard is one no test can hold to account.
    if(!(key > 0)) return;
    if(best === null || key > bestKey){ best = r; bestKey = key; }
  });
  if(!best) return null;
  const value = Number((best.months || [])[monthIdx] || 0);
  const target = Number(best.target) > 0 ? Number(best.target) : null;
  return { name: best.agent, team: best.team || '', campus: best.campus,
    value, target, pct: target ? value / target : null };
}
function competitionHighlights(rows, monthIdx){
  const dub = (rows || []).filter(r => r.campus === 'dublin');
  const lim = (rows || []).filter(r => r.campus === 'limerick');
  const by = (kind) => ({
    company: competitionWinner(rows, monthIdx, kind),
    dublin: competitionWinner(dub, monthIdx, kind),
    limerick: competitionWinner(lim, monthIdx, kind),
  });
  return { staff_of_month: by('staff'), sales_star: by('star') };
}
// Standard competition ranking: equal figures share a place, and the next
// one down skips. Two people on 10k are both second, and nobody is third.
function competitionRanking(rows, monthIdx){
  const list = (rows || []).map(r => {
    const value = Number((r.months || [])[monthIdx] || 0);
    const target = Number(r.target) > 0 ? Number(r.target) : null;
    return { name: r.agent, team: r.team || '', campus: r.campus,
      value, target, pct: target ? value / target : null };
  }).sort((a,b) => b.value - a.value || String(a.name).localeCompare(String(b.name)));
  let lastValue = null, lastRank = 0;
  list.forEach((row, i) => {
    if(lastValue !== null && row.value === lastValue) row.rank = lastRank;
    else { row.rank = i + 1; lastRank = row.rank; lastValue = row.value; }
  });
  return list;
}
// Best effort, and only that: the sheet is maintained by hand and the
// directory is not, so a winner whose name does not match a profile is still
// a winner. Matching never decides anything - it only finds a face.
function attachProfile(winner, profiles){
  if(!winner) return null;
  const key = String(winner.name || '').trim().toLowerCase();
  if(!key) return winner;
  const hit = (profiles || []).find(u =>
    [u.first, u.last].filter(Boolean).join(' ').trim().toLowerCase() === key);
  if(!hit) return winner;
  return Object.assign({}, winner, { user_id: hit.id, photo: hit.photo || '' });
}
// Pure, side-effect-free, exported so the parsing and the ranking can be
// asserted directly against fixture CSV - the test environment cannot reach
// Google, and a test that depends on a live sheet is not a test.
exports.__competition = { cleanAgent, parseEuro, parseCell, parseCsv,
  parseCompetitionCsv, competitionWinner, competitionHighlights,
  competitionRanking, attachProfile, competitionUrl, COMP_MONTHS };
exports.__setCompetitionFetch = (fn) => { __compFetch = (typeof fn === 'function') ? fn : null; };
exports.__clearCompetitionCache = () => { __compCache.clear(); };

// ── HALL OF FAME ─────────────────────────────────────────────────
// The ranking is live from the sheet, and the sheet is per YEAR: next
// January the tabs become "Dublin 2027" and 2026's figures stop being
// reachable. So each month is frozen into hof_winners once it closes, and
// from then on the archive - not the sheet - is what the past means.
//
// There is no scheduler. Archiving happens lazily, whenever anybody opens
// Competitions or the Hall of Fame, which is the moment with the best
// chance of catching a month before the year rolls over.
const HOF_SCOPES = ['company','dublin','limerick'];
const HOF_AWARDS = ['staff_of_month','sales_star'];

// Which year the configured sheet is about, read from the tab name. A tab
// nobody has renamed yet falls back to the year we are in, which is the
// only honest guess available.
function sheetYear(src, now){
  const m = /(\d{4})/.exec(String((src && src.dublin_tab) || ''));
  if(m){
    const y = Number(m[1]);
    if(y >= 2000 && y <= 2100) return y;
  }
  return Number(dublinYMD(now || new Date()).slice(0,4));
}
// A month is complete when it is wholly in the past, in Dublin. The month
// we are in is NOT complete - its winner can still change - and a sheet for
// a year that has not started has no complete months at all.
function completedMonths(year, now){
  const today = dublinYMD(now || new Date());
  const curY = Number(today.slice(0,4)), curM = Number(today.slice(5,7));
  if(year < curY) return [1,2,3,4,5,6,7,8,9,10,11,12];
  if(year > curY) return [];
  const out = [];
  for(let m = 1; m < curM; m++) out.push(m);
  return out;
}
// Freeze every completed month that is not already in the archive.
//
// A month that already has ANY row is left strictly alone: the archive is
// the source of truth for the past, so a figure corrected in the sheet
// afterwards must not rewrite a prize that was already awarded. The unique
// index is belt and braces behind that, for two readers arriving at once.
async function archiveCompletedMonths(src, data, now){
  // No sheet, no archiving. Silently: what is already archived stays, and
  // the caller has its own way of saying the sheet is unreadable.
  if(!src || !data || data.error || !Array.isArray(data.rows)) return { skipped:true };
  const year = sheetYear(src, now);
  const months = completedMonths(year, now);
  if(!months.length) return { archived:0, months:[] };
  const { data: existing } = await admin.from('hof_winners')
    .select('year,month,scope,award').eq('year', year);
  const seen = new Set();
  (existing || []).forEach(r => { seen.add(Number(r.month)); });
  const captured_at = new Date().toISOString();
  let archived = 0;
  const done = [];
  for(const month of months){
    if(seen.has(month)) continue;             // already frozen; never redone
    const hi = competitionHighlights(data.rows, month - 1);
    const rows = [];
    HOF_AWARDS.forEach(award => {
      const group = award === 'staff_of_month' ? hi.staff_of_month : hi.sales_star;
      HOF_SCOPES.forEach(scope => {
        const w = group[scope];
        if(!w) return;                        // nobody qualified; nothing to freeze
        rows.push({ year, month, scope, award,
          agent_name: w.name, team: w.team || '',
          value: w.value, target: w.target, pct: w.pct, captured_at });
      });
    });
    if(!rows.length) continue;                // a month nobody sold in archives nothing
    // One at a time, tolerating the unique violation: in Postgres a batch
    // where one row conflicts fails the whole batch, and "do nothing" is
    // exactly what a conflict should mean here.
    for(const row of rows){
      const { error } = await admin.from('hof_winners').insert(row);
      if(error && error.code !== '23505') return { error:'archive_failed', detail:error.message };
      if(!error) archived++;
    }
    done.push(month);
  }
  return { archived, months: done };
}
function hofWinnerOut(r){
  if(!r) return null;
  return { agent_name: r.agent_name || '', team: r.team || '',
    value: Number(r.value || 0),
    target: (r.target === null || r.target === undefined) ? null : Number(r.target),
    pct: (r.pct === null || r.pct === undefined) ? null : Number(r.pct) };
}
exports.__hof = { sheetYear, completedMonths, archiveCompletedMonths, hofWinnerOut };

// ── ASSIGNMENTS ──────────────────────────────────────────────────
// A manager gives one person a task, a project or a training. Tasks and
// projects are a handshake - the assignee says done, the manager confirms -
// and a training is not: it completes when its test is passed, which the
// training system already records. So a training's status column is never
// the authority; the pass is.
const ASSIGNMENT_TYPES = ['task','project','training'];
const ASSIGNMENT_STATUSES = ['assigned','submitted','done','cancelled'];

// Every passing completion for the pairs we are about to judge, in ONE
// query. A per-row lookup would be a query per training on every page load.
// The key is user and content together, because the same training passed by
// a different person says nothing about this one.
function assignmentPassKey(userId, contentId){ return String(userId) + '|' + String(contentId); }
async function assignmentPasses(rows){
  const out = new Map();
  const pairs = (rows || []).filter(r => r.type === 'training' && r.content_id);
  if(!pairs.length) return out;
  const userIds = Array.from(new Set(pairs.map(r => r.user_id)));
  const contentIds = Array.from(new Set(pairs.map(r => r.content_id)));
  // A completion row exists ONLY when a test was passed - submit_test mints
  // it after the threshold check and not before - so its presence is the
  // pass, and its completed_at is the date the prize was earned.
  const { data } = await admin.from('training_completions')
    .select('user_id,content_id,completed_at').in('user_id', userIds).in('content_id', contentIds);
  (data || []).forEach(c => {
    const k = assignmentPassKey(c.user_id, c.content_id);
    const prev = out.get(k);
    // The earliest pass is the one that counts: passing again later does not
    // make somebody later than they were.
    if(!prev || String(c.completed_at || '') < String(prev)) out.set(k, c.completed_at || null);
  });
  return out;
}
// What this assignment actually amounts to, for one row. The single place
// that decides "is it done, when, and was that on time" - the list, the
// team board and (later) the appraisal summary all read it from here, so
// they cannot disagree about somebody's record.
function assignmentEffective(row, passLookup, today){
  const type = row && row.type;
  let done = false, completed_at = null;
  if(type === 'training'){
    const at = passLookup && passLookup.get(assignmentPassKey(row.user_id, row.content_id));
    if(at !== undefined && at !== null){ done = true; completed_at = at; }
  } else {
    done = row && row.status === 'done';
    completed_at = done ? (row.completed_at || null) : null;
  }
  const due = row && row.due_date ? String(row.due_date).slice(0,10) : null;
  const now = today || dublinYMD(new Date());
  let label;
  if(row && row.status === 'cancelled' && type !== 'training') label = 'cancelled';
  else if(done){
    // No due date means nothing to be late for.
    if(!due) label = 'on_time';
    else label = (String(completed_at || '').slice(0,10) <= due) ? 'on_time' : 'late';
  } else {
    if(!due) label = 'pending';
    else label = (due < now) ? 'overdue' : 'pending';
  }
  return { done, completed_at, label };
}
// One row, field by field. assigned_by and the raw timestamps the client has
// no use for stay on the server.
function assignmentOut(row, eff){
  return { id: row.id, type: row.type, title: row.title || '',
    description: row.description || '', due_date: row.due_date || null,
    status: row.status, content_id: row.content_id || null,
    submitted_at: row.submitted_at || null,
    effective_done: eff.done, effective_completed_at: eff.completed_at,
    effective_label: eff.label };
}
// The one scope question for every assignment write that lands on somebody
// else. Self is NOT a shortcut here: a manager assigning themselves work is
// the same question as assigning anybody else, and canActOn answers it.
async function assignmentTarget(me, userId){
  if(!userId) return { ok:false, status:400, error:'missing_user' };
  const { data: tgt } = await admin.from('profiles')
    .select('id,first,last,nickname,role,role_id,status').eq('id', userId).single();
  if(!tgt) return { ok:false, status:404, error:'not_found' };
  if(!await canActOn(me, tgt)) return { ok:false, status:403, error:'out_of_scope' };
  return { ok:true, tgt };
}
// A row the caller may act on as its MANAGER.
async function assignmentForManager(me, id){
  if(!id) return { ok:false, status:400, error:'missing_id' };
  const { data: row } = await admin.from('assignments')
    .select('id,user_id,type,title,description,content_id,due_date,status,submitted_at,completed_at')
    .eq('id', id).single();
  if(!row) return { ok:false, status:404, error:'not_found' };
  const who = await assignmentTarget(me, row.user_id);
  if(!who.ok) return who;
  return { ok:true, row, tgt: who.tgt };
}
exports.__assignments = { assignmentEffective, assignmentPassKey, ASSIGNMENT_TYPES };

// ── APPRAISALS ───────────────────────────────────────────────────
// The template content itself lives in the client, assembled from
// building blocks per cadence and cargo. What the gateway needs is the
// set of keys that assembly can produce, so nothing is ever stored
// under a template name that no reader will be able to render it with.
const APPRAISAL_CADENCES = ['Annual','Semi-Annual','Quarterly','Probation'];
const APPRAISAL_CARGOS = ['Sales_Agent','Team_Leader','Sales_Supervisor','Sales_Manager'];
const APPRAISAL_TEMPLATES = APPRAISAL_CADENCES.reduce(
  (keys, cadence) => keys.concat(APPRAISAL_CARGOS.map(cargo => cadence + '_' + cargo)), []);
// Not Observed is an answer, and it is stored as null - the rating
// column is nullable now precisely so that "not rated" and "rated a 1"
// stop being the same row. Anything that is neither 1-5 nor N/A is a bad
// request rather than a quiet zero.
function appraisalRating(v){
  if(v === null || v === undefined || v === '' || v === 'NA' || v === 'N/A') return { ok:true, value:null };
  const n = Number(v);
  if(Number.isInteger(n) && n >= 1 && n <= 5) return { ok:true, value:n };
  return { ok:false, value:null };
}
// responses IS the appraisal. An array or a string would store happily in
// a jsonb column and then render as nothing at all, so the shape is
// settled here rather than discovered by whoever opens the record next.
function isResponseMap(v){
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
exports.__appraisals = { APPRAISAL_TEMPLATES, APPRAISAL_CADENCES, APPRAISAL_CARGOS,
  appraisalRating, isResponseMap };

exports.handler = async (event) => {
  if(event.httpMethod !== 'POST') return json(405, { error:'method_not_allowed' });
  let p; try { p = JSON.parse(event.body || '{}'); } catch { return json(400,{error:'bad_json'}); }
  const caller = await getCaller(event);
  if(!caller) return json(401, { error:'unauthorized' });
  try {
    switch(p.action){
      case 'get_my_profile': {
        const { data, error } = await admin.from('profiles')
          .select('*').eq('id', caller.id).single();
        if(error) return json(404, { error:'profile_not_found' });
        return json(200, { profile: data });
      }
      case 'set_theme': {
        // A self preference: the caller's own id is the only one this can touch,
        // so it deliberately ignores any user_id in the payload.
        const theme = String(p.theme == null ? '' : p.theme);
        if(theme !== 'light' && theme !== 'dark') return json(400,{error:'bad_theme'});
        const { error } = await admin.from('profiles')
          .update({ theme }).eq('id', caller.id);
        if(error) return json(500,{error:'save_failed'});
        return json(200,{ ok:true, theme });
      }
      case 'get_threads': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const { ids: myTeamIds, teams } = await chatTeamIdsOf(me);
        const teamById = {}; teams.forEach(t => { teamById[t.id] = t; });
        for(const tid of myTeamIds) await findOrCreateGroup(tid);
        const { data: allThreads } = await admin.from('threads').select('*');
        const mine = (allThreads||[]).filter(t =>
          (t.kind==='group' && t.team_id!=null && myTeamIds.includes(t.team_id)) ||
          (t.kind==='dm' && (t.user_a===me.id || t.user_b===me.id)));
        const ids = mine.map(t => t.id);
        const { data: msgs } = ids.length
          ? await admin.from('messages').select('id,thread_id,sender_id,body,created_at').in('thread_id', ids)
          : { data: [] };
        const { data: reads } = await admin.from('thread_reads')
          .select('thread_id,last_read_at').eq('user_id', me.id);
        const readAt = {}; (reads||[]).forEach(r => { readAt[r.thread_id] = r.last_read_at; });
        const { data: profs } = await admin.from('profiles').select('id,first,last,nickname,photo,role');
        const profById = {}; (profs||[]).forEach(u => { profById[u.id] = u; });
        const out = mine.map(t => {
          const rows = (msgs||[]).filter(m => m.thread_id === t.id)
            .sort((x,y) => Number(x.id) - Number(y.id));
          const last = rows.length ? rows[rows.length-1] : null;
          const since = readAt[t.id] || null;
          // Your own messages never count as unread, however late you read them.
          const unread = rows.filter(m => m.sender_id !== me.id &&
            (!since || String(m.created_at) > String(since))).length;
          let name = '', other = null;
          if(t.kind === 'dm'){
            const otherId = t.user_a === me.id ? t.user_b : t.user_a;
            const u = profById[otherId];
            other = u ? { id:u.id, first:u.first, last:u.last, nickname:u.nickname||'', photo:u.photo||'' } : { id:otherId, first:'?', last:'', nickname:'', photo:'' };
            name = (other.first + ' ' + other.last).trim();
          } else {
            name = (teamById[t.team_id] || {}).name || 'Team';
          }
          return { id:t.id, kind:t.kind, team_id:t.team_id ?? null, name, other,
            unread, last_message: last ? { body:last.body, created_at:last.created_at,
              sender_id:last.sender_id, sender_first:(profById[last.sender_id]||{}).first || '?' } : null };
        });
        return json(200,{ threads: out });
      }
      case 'get_messages': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.thread_id) return json(400,{error:'missing_thread'});
        const { data: thread } = await admin.from('threads').select('*').eq('id', p.thread_id).single();
        if(!thread) return json(404,{error:'not_found'});
        if(!await memberOfThread(me, thread)) return json(403,{error:'forbidden'});
        const { data } = await admin.from('messages')
          .select('id,sender_id,body,created_at').eq('thread_id', thread.id);
        // id is a bigint identity, so it orders and paginates without the tie
        // problems created_at has at sub-millisecond resolution.
        let rows = (data||[]).slice().sort((a,b) => Number(b.id) - Number(a.id));
        if(p.before != null) rows = rows.filter(m => Number(m.id) < Number(p.before));
        const page = rows.slice(0, MSG_PAGE).reverse();
        return json(200,{ thread_id: thread.id, messages: page,
          has_more: rows.length > MSG_PAGE, cursor: page.length ? page[0].id : null });
      }
      case 'send_message': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const body = String(p.body == null ? '' : p.body).trim();
        if(!body) return json(400,{error:'empty_body'});
        if(body.length > MSG_MAX) return json(400,{error:'body_too_long'});
        let thread = null;
        if(p.thread_id){
          const { data } = await admin.from('threads').select('*').eq('id', p.thread_id).single();
          if(!data) return json(404,{error:'not_found'});
          thread = data;
        } else if(p.to_user_id){
          if(String(p.to_user_id) === String(me.id)) return json(400,{error:'no_self_dm'});
          const { data: tgt } = await admin.from('profiles').select('id').eq('id', p.to_user_id).single();
          if(!tgt) return json(404,{error:'not_found'});
          thread = await findOrCreateDm(me.id, tgt.id);
        } else if(p.team_id != null){
          const { ids } = await chatTeamIdsOf(me);
          if(!ids.includes(p.team_id)) return json(403,{error:'forbidden'});
          thread = await findOrCreateGroup(p.team_id);
        } else {
          return json(400,{error:'missing_target'});
        }
        if(!thread) return json(500,{error:'send_failed'});
        if(!await memberOfThread(me, thread)) return json(403,{error:'forbidden'});
        // sender_id is the resolved caller, never anything the client sent.
        const { data: row, error } = await admin.from('messages')
          .insert({ thread_id: thread.id, sender_id: me.id, body })
          .select('id,thread_id,sender_id,body,created_at').single();
        if(error) return json(500,{error:'send_failed'});
        return json(200,{ ok:true, thread_id: thread.id, message: row });
      }
      case 'mark_read': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.thread_id) return json(400,{error:'missing_thread'});
        const { data: thread } = await admin.from('threads').select('*').eq('id', p.thread_id).single();
        if(!thread) return json(404,{error:'not_found'});
        if(!await memberOfThread(me, thread)) return json(403,{error:'forbidden'});
        const last_read_at = new Date().toISOString();
        const { error } = await admin.from('thread_reads')
          .upsert({ thread_id: thread.id, user_id: me.id, last_read_at },
                  { onConflict: 'thread_id,user_id' });
        if(error) return json(500,{error:'save_failed'});
        return json(200,{ ok:true, thread_id: thread.id, last_read_at });
      }
      case 'set_password_changed': {
        const { error } = await admin.from('profiles')
          .update({ must_change_password:false }).eq('id', caller.id);
        if(error) return json(500, { error:'update_failed' });
        return json(200, { ok:true });
      }
      case 'update_last_login': {
        await admin.from('profiles')
          .update({ last_login:new Date().toISOString() }).eq('id', caller.id);
        return json(200, { ok:true });
      }
      case 'get_directory': {
        const { data, error } = await admin.from('profiles')
          .select('id,first,last,nickname,email,role,campus,phone,instagram,linkedin,nationality,language,languages,birth_day,birth_month,job_title,status,reports_to,photo,bio,monthly_target,role_id,team_id,start_date')
          .order('first',{ascending:true});
        if(error) return json(500,{error:'directory_failed'});
        return json(200,{ directory:data });
      }
      case 'list_users': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const { data, error } = await admin.from('profiles')
          .select('*').order('first',{ascending:true});
        if(error) return json(500,{error:'list_failed'});
        // .neq() takes a single value, so the rank filter runs here instead of
        // in the query - it has to exclude every tier above the caller. A local
        // leader is then narrowed again to their own branch: this list feeds
        // every management screen and every "reports to" picker.
        const scope = await scopeIdsFor(me);
        return json(200,{ users:(data||[])
          .filter(u => outranks(me.role, u.role))
          .filter(u => scope === null || scope.has(u.id)) });
      }
      case 'create_user': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const b = p.user || {};
        const email = (b.email||'').trim().toLowerCase();
        const first = (b.first||'').trim();
        const last  = (b.last||'').trim();
        const password = b.password || '';
        const ROLES = ROLE_LEVELS;
        if(!email || !first || !last) return json(400,{error:'missing_fields'});
        // The cargo decides the base permission level; every existing check then
        // runs against that base exactly as before.
        if(!b.role_id) return json(400,{error:'missing_role_id'});
        const { data: cargo } = await admin.from('roles')
          .select('id,base_level,active').eq('id', b.role_id).single();
        if(!cargo) return json(404,{error:'role_not_found'});
        if(cargo.active === false) return json(400,{error:'role_inactive'});
        const role = cargo.base_level;
        if(!ROLES.includes(role)) return json(400,{error:'bad_role'});
        if(password.length < 6) return json(400,{error:'weak_password'});
        if(!outranks(me.role, role)) return json(403,{error:'forbidden_role'});
        // Resolve the team before anything is created, so a bad team can never
        // leave an orphaned auth user behind. Its leader wins as reports_to.
        let teamId = null, reportsTo = b.reports_to || null;
        if(b.team_id){
          const { data: team } = await admin.from('teams').select('id,active,leader_id').eq('id',b.team_id).single();
          if(!team) return json(404,{error:'team_not_found'});
          if(team.active === false) return json(400,{error:'team_inactive'});
          teamId = team.id;
          if(team.leader_id) reportsTo = team.leader_id;
        }
        // A local leader may only hang a new person off their own branch -
        // otherwise create_user is a way to grow a tree you do not own. The
        // caller counts as in scope, so reporting someone to yourself is fine.
        // Checked before anything is created, like the team above.
        if(reportsTo != null){
          const scope = await scopeIdsFor(me);
          if(scope !== null && !scope.has(reportsTo))
            return json(403,{error:'reports_to_out_of_scope'});
        }
        // Validated before anything is created: a bad date must not leave an
        // orphaned auth user behind, the same reason the team is resolved above.
        const sd = normStartDate(b.start_date);
        if(!sd.ok) return json(400,{error:'bad_start_date'});
        const startDate = sd.value;
        const { data: created, error: cErr } = await admin.auth.admin.createUser({
          email, password, email_confirm:true
        });
        if(cErr) return json(400,{error:'auth_create_failed', detail:cErr.message});
        const newId = created.user.id;
        const campus = ['dublin','limerick','both'].includes((b.campus||'').toLowerCase())
          ? (b.campus).toLowerCase() : 'dublin';
        const { error: pErr } = await admin.from('profiles').insert({
          id:newId, first, last, email, role, campus, role_id: cargo.id,
          team_id: teamId, phone: b.phone || '',
          reports_to: reportsTo, start_date: startDate,
          status: (b.status === 'inactive') ? 'inactive' : 'active',
          must_change_password:true
        });
        if(pErr){
          await admin.auth.admin.deleteUser(newId);
          if(pErr.code === '23505') return json(409,{error:'email_exists'});
          return json(500,{error:'profile_insert_failed', detail:pErr.message});
        }
        return json(200,{ ok:true, id:newId });
      }
      case 'reset_password': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const targetId = p.id; const password = p.password || '';
        if(!targetId) return json(400,{error:'missing_id'});
        if(password.length < 6) return json(400,{error:'weak_password'});
        const { data: tgt } = await admin.from('profiles').select('id,role').eq('id',targetId).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await canActOn(me, tgt)) return json(403,{error:'forbidden'});
        const { error:aErr } = await admin.auth.admin.updateUserById(targetId,{ password });
        if(aErr) return json(500,{error:'reset_failed', detail:aErr.message});
        await admin.from('profiles').update({ must_change_password:true }).eq('id',targetId);
        return json(200,{ ok:true });
      }
      case 'set_user_status': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const targetId = p.id; const status = p.status;
        if(!targetId || !['active','inactive'].includes(status)) return json(400,{error:'bad_input'});
        if(targetId === me.id) return json(400,{error:'cannot_change_self'});
        const { data: tgt } = await admin.from('profiles').select('id,role').eq('id',targetId).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await canActOn(me, tgt)) return json(403,{error:'forbidden'});
        const { error } = await admin.from('profiles').update({ status }).eq('id',targetId);
        if(error) return json(500,{error:'status_failed'});
        return json(200,{ ok:true });
      }
      case 'get_performance': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const year = Number(p.year) || new Date().getFullYear();
        const ids = await accessibleIds(me);
        const { data: rows, error } = await admin.from('sales_results')
          .select('user_id,year,month,target,actual,notes').eq('year',year).in('user_id',ids);
        if(error) return json(500,{error:'perf_failed'});
        const { data: profs } = await admin.from('profiles')
          .select('id,role,role_id,monthly_target').in('id',ids);
        const { data: roleRows } = await admin.from('roles')
          .select('id,base_level,individual_target');
        const byRole = {}; (roleRows||[]).forEach(r=>{ byRole[r.id]=r; });
        // Individual ladder, unchanged:
        //   monthly_target ?? cargo.individual_target ?? ROLE_TARGETS[base] ?? 0
        const eff = {};
        (profs||[]).forEach(u=>{
          const cargo = (u.role_id!=null) ? byRole[u.role_id] : null;
          eff[u.id] = (u.monthly_target!=null) ? Number(u.monthly_target)
            : (cargo && cargo.individual_target!=null) ? Number(cargo.individual_target)
            : (ROLE_TARGETS[u.role]||0);
        });

        // ── per-team figures ──────────────────────────────────────
        // Target lives on the team; actual is the sum over its members.
        const { data: allTeams } = await admin.from('teams')
          .select('id,name,leader_id,campus,team_target,active');
        const { data: allProfs } = await admin.from('profiles').select('id,team_id,reports_to');
        const teamIds = await accessibleTeamIds(me, allTeams||[], allProfs||[]);
        const memberIds = (allProfs||[])
          .filter(u => u.team_id!=null && teamIds.includes(u.team_id)).map(u => u.id);
        // Team actuals need every member's rows, even ones outside the caller's
        // per-person scope; the per-user payload below stays scoped to `ids`.
        const extra = memberIds.filter(id => !ids.includes(id));
        let teamRows = rows || [];
        if(extra.length){
          const { data: more } = await admin.from('sales_results')
            .select('user_id,year,month,target,actual').eq('year',year).in('user_id',extra);
          teamRows = teamRows.concat(more||[]);
        }
        const now = new Date();
        const M = (year === now.getFullYear()) ? now.getMonth()+1 : 12;
        const qs = Math.floor((M-1)/3)*3+1;
        const teamOf = {}; (allProfs||[]).forEach(u => { teamOf[u.id] = u.team_id; });
        const sums = {};
        teamIds.forEach(id => { sums[id] = { monthly:0, quarterly:0, annual:0 }; });
        teamRows.forEach(r => {
          const tid = teamOf[r.user_id];
          if(tid==null || !sums[tid]) return;
          const a = Number(r.actual)||0;
          if(r.month === M) sums[tid].monthly += a;
          if(r.month >= qs && r.month < qs+3) sums[tid].quarterly += a;
          sums[tid].annual += a;
        });
        const team_perf = (allTeams||[]).filter(t => teamIds.includes(t.id)).map(t => ({
          team_id: t.id, name: t.name, leader_id: t.leader_id, campus: t.campus,
          target: (t.team_target!=null) ? Number(t.team_target) : null,
          actual: sums[t.id] || { monthly:0, quarterly:0, annual:0 }
        }));

        return json(200,{ year, month: M, results: rows||[], effective_targets: eff, team_perf });
      }
      case 'set_result': {
        const me = await callerProfile(caller);
        if(!me || !canUpdatePerf(me.role)) return json(403,{error:'forbidden'});
        const uid=p.user_id, year=Number(p.year), month=Number(p.month),
          target=Number(p.target), actual=Number(p.actual), notes=(p.notes||'').toString();
        if(!uid || !(month>=1&&month<=12) || !(year>=2000&&year<=2100)) return json(400,{error:'bad_input'});
        if(!(target>=0)||!(actual>=0)) return json(400,{error:'bad_numbers'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await inScope(me,tgt)) return json(403,{error:'out_of_scope'});
        const { error } = await admin.from('sales_results').upsert(
          { user_id:uid, year, month, target, actual, notes,
            updated_by:me.id, updated_at:new Date().toISOString() },
          { onConflict:'user_id,year,month' });
        if(error) return json(500,{error:'save_failed', detail:error.message});
        if(p.set_base_target) await admin.from('profiles').update({monthly_target:target}).eq('id',uid);
        return json(200,{ ok:true });
      }
      case 'set_monthly_target': {
        const me = await callerProfile(caller);
        if(!me || !canUpdatePerf(me.role)) return json(403,{error:'forbidden'});
        const uid=p.user_id;
        const val=(p.monthly_target===null||p.monthly_target==='')?null:Number(p.monthly_target);
        if(!uid) return json(400,{error:'missing_id'});
        if(val!=null && !(val>=0)) return json(400,{error:'bad_number'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await inScope(me,tgt)) return json(403,{error:'out_of_scope'});
        const { error } = await admin.from('profiles').update({monthly_target:val}).eq('id',uid);
        if(error) return json(500,{error:'save_failed'});
        return json(200,{ ok:true });
      }
      case 'get_roles': {
        const { data, error } = await admin.from('roles')
          .select('id,name,base_level,individual_target,active').order('name',{ascending:true});
        if(error) return json(500,{error:'roles_failed'});
        return json(200,{ roles:data||[] });
      }
      case 'create_role': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const name = (p.name||'').toString().trim();
        const base_level = (p.base_level||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        if(!ROLE_LEVELS.includes(base_level)) return json(400,{error:'bad_base_level'});
        // You may not mint a tier above your own, mirroring create_user.
        if(!outranks(me.role, base_level)) return json(403,{error:'forbidden_role'});
        const individual_target = numOrNull(p.individual_target);
        if(individual_target===false) return json(400,{error:'bad_number'});
        const { data, error } = await admin.from('roles')
          .insert({ name, base_level, individual_target, active:true })
          .select('id').single();
        if(error){
          if(error.code === '23505') return json(409,{error:'name_exists'});
          return json(500,{error:'create_failed', detail:error.message});
        }
        return json(200,{ ok:true, id:data && data.id });
      }
      case 'update_role': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const id = p.id;
        if(!id) return json(400,{error:'missing_id'});
        const name = (p.name||'').toString().trim();
        const base_level = (p.base_level||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        if(!ROLE_LEVELS.includes(base_level)) return json(400,{error:'bad_base_level'});
        const individual_target = numOrNull(p.individual_target);
        if(individual_target===false) return json(400,{error:'bad_number'});
        const { data: existing } = await admin.from('roles').select('id,base_level').eq('id',id).single();
        if(!existing) return json(404,{error:'not_found'});
        // Neither the new tier nor the tier being replaced may outrank you.
        if(!outranks(me.role, base_level) || !outranks(me.role, existing.base_level))
          return json(403,{error:'forbidden_role'});
        const { error } = await admin.from('roles')
          .update({ name, base_level, individual_target, active: p.active !== false })
          .eq('id',id);
        if(error){
          if(error.code === '23505') return json(409,{error:'name_exists'});
          return json(500,{error:'update_failed', detail:error.message});
        }
        // Holders' permission tier follows the cargo.
        if(existing.base_level !== base_level){
          const { error: cErr } = await admin.from('profiles').update({ role: base_level }).eq('role_id', id);
          if(cErr) return json(500,{error:'cascade_failed', detail:cErr.message});
        }
        return json(200,{ ok:true, cascaded: existing.base_level !== base_level });
      }
      case 'delete_role': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const id = p.id;
        if(!id) return json(400,{error:'missing_id'});
        const { data: existing } = await admin.from('roles').select('id,base_level').eq('id',id).single();
        if(!existing) return json(404,{error:'not_found'});
        // Permission before state, so the caller gets the honest reason.
        if(!outranks(me.role, existing.base_level)) return json(403,{error:'forbidden_role'});
        const { data: holders } = await admin.from('profiles').select('id').eq('role_id', id);
        if(holders && holders.length) return json(409,{error:'in_use', count:holders.length});
        const { error } = await admin.from('roles').delete().eq('id',id);
        if(error) return json(500,{error:'delete_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      // ── LEAD SOURCES (admin) ─────────────────────────────────
      case 'get_lead_sources': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const { data, error } = await admin.from('lead_sources')
          .select('id,name,active,sort_order')
          .order('sort_order',{ascending:true}).order('name',{ascending:true});
        if(error) return json(500,{error:'sources_failed', detail:error.message});
        return json(200,{ sources:(data||[]).map(r=>({
          id:r.id, name:r.name, active: r.active !== false,
          sort_order: Number.isFinite(Number(r.sort_order)) ? Number(r.sort_order) : 0 })) });
      }
      case 'create_lead_source': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const name = (p.name||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        const sort_order = Number.isFinite(Number(p.sort_order)) ? Number(p.sort_order) : 0;
        const { data, error } = await admin.from('lead_sources')
          .insert({ name, active:true, sort_order }).select('id').single();
        if(error){
          if(error.code === '23505') return json(409,{error:'name_exists'});
          return json(500,{error:'create_failed', detail:error.message});
        }
        return json(200,{ ok:true, id:data && data.id });
      }
      case 'update_lead_source': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const name = (p.name||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        const { data: existing } = await admin.from('lead_sources').select('id').eq('id',p.id).single();
        if(!existing) return json(404,{error:'not_found'});
        const patch = { name, active: p.active !== false };
        if(p.sort_order !== undefined && Number.isFinite(Number(p.sort_order)))
          patch.sort_order = Number(p.sort_order);
        const { error } = await admin.from('lead_sources').update(patch).eq('id',p.id);
        if(error){
          if(error.code === '23505') return json(409,{error:'name_exists'});
          return json(500,{error:'update_failed', detail:error.message});
        }
        return json(200,{ ok:true });
      }
      case 'delete_lead_source': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: existing } = await admin.from('lead_sources').select('id').eq('id',p.id).single();
        if(!existing) return json(404,{error:'not_found'});
        // A source somebody has already reported against is history, not
        // configuration: deleting it would silently rewrite past weeks.
        const { data: used } = await admin.from('weekly_lead_rows').select('id').eq('source_id', p.id);
        if(used && used.length) return json(409,{error:'in_use', count:used.length});
        const { error } = await admin.from('lead_sources').delete().eq('id',p.id);
        if(error) return json(500,{error:'delete_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      // ── THE WEEK ─────────────────────────────────────────────
      case 'get_week': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const c = await currentCycle();
        if(!c.ok) return json(500,{error:c.error, detail:c.detail});
        return json(200,{ cycle:c.cycle, window: weekWindowInfo(me, c.cycle, weekNow()) });
      }
      case 'get_my_week_entry': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const c = await currentCycle();
        if(!c.ok) return json(500,{error:c.error, detail:c.detail});
        const { data: entry } = await admin.from('weekly_entries')
          .select('id,sales_dub_received,sales_dub_expected,sales_lim_received,sales_lim_expected,submitted,submitted_at')
          .eq('cycle_id', c.cycle.id).eq('user_id', me.id).single();
        // The leads list is the ACTIVE source list, not whatever happens to be
        // saved: a source added this morning has to appear on the form, and a
        // deactivated one has to drop off it.
        const { data: sources } = await admin.from('lead_sources')
          .select('id,name,active,sort_order').eq('active', true)
          .order('sort_order',{ascending:true}).order('name',{ascending:true});
        const saved = {};
        if(entry){
          const { data: rows } = await admin.from('weekly_lead_rows')
            .select('source_id,received,sold').eq('entry_id', entry.id);
          (rows||[]).forEach(r=>{ saved[String(r.source_id)] = r; });
        }
        // Field by field, and zeros rather than nulls: a person who has never
        // filed anything gets a clean form, not an error and not blanks.
        return json(200,{
          week: c.cycle,
          window: weekWindowInfo(me, c.cycle, weekNow()),
          entry: {
            exists: !!entry,
            sales_dub_received: entry ? Number(entry.sales_dub_received||0) : 0,
            sales_dub_expected: entry ? Number(entry.sales_dub_expected||0) : 0,
            sales_lim_received: entry ? Number(entry.sales_lim_received||0) : 0,
            sales_lim_expected: entry ? Number(entry.sales_lim_expected||0) : 0,
            submitted: entry ? !!entry.submitted : false,
            submitted_at: entry ? (entry.submitted_at||null) : null
          },
          leads: (sources||[]).map(s=>({
            source_id: s.id, name: s.name,
            received: saved[String(s.id)] ? Number(saved[String(s.id)].received||0) : 0,
            sold:     saved[String(s.id)] ? Number(saved[String(s.id)].sold||0)     : 0
          }))
        });
      }
      case 'save_week_entry': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        // A boss may fill a member's line for them. Whose row this writes is
        // decided here and nowhere else, before a single value is read.
        const who = await weekTargetFor(me, p.target_user_id);
        if(!who.ok) return json(who.status,{error:who.error});
        // Only ever the CURRENT cycle: there is no parameter that names a
        // past week, so history cannot be rewritten by any caller.
        const c = await currentCycle();
        if(!c.ok) return json(500,{error:c.error, detail:c.detail});
        // The clock, on the CALLER's band. A leader filling an agent's line
        // writes in the leader window, not the agent's - the question is who
        // is doing the typing, not whose row it lands in.
        {
          const now = weekNow();
          if(!canWriteNow(me, c.cycle, now))
            return json(403,{ error:'window_closed', window: weekWindowInfo(me, c.cycle, now) });
        }
        const nums = {
          sales_dub_received: weekAmount(p.sales_dub_received),
          sales_dub_expected: weekAmount(p.sales_dub_expected),
          sales_lim_received: weekAmount(p.sales_lim_received),
          sales_lim_expected: weekAmount(p.sales_lim_expected)
        };
        for(const k of Object.keys(nums)){
          if(nums[k] === false) return json(400,{error:'bad_number', field:k});
        }
        // Validate every lead row BEFORE writing anything, so a bad one
        // cannot leave the week half saved.
        const leadsIn = Array.isArray(p.leads) ? p.leads : [];
        const cleaned = [];
        for(const row of leadsIn){
          if(!row || row.source_id === undefined || row.source_id === null) continue;
          const received = weekCount(row.received), sold = weekCount(row.sold);
          if(received === false || sold === false) return json(400,{error:'bad_count'});
          cleaned.push({ source_id: row.source_id, received, sold });
        }
        const { data: active } = await admin.from('lead_sources').select('id').eq('active', true);
        const allowed = new Set((active||[]).map(s=>String(s.id)));
        // Unknown or deactivated sources are dropped, not rejected: an open
        // form from before a source was retired should still save.
        const keep = cleaned.filter(r => allowed.has(String(r.source_id)));

        const { data: existing } = await admin.from('weekly_entries')
          .select('id').eq('cycle_id', c.cycle.id).eq('user_id', who.user_id).single();
        // last_edited_by is the CALLER, not the owner - that is the whole
        // point of recording it, so a filled-in row says who filled it.
        const patch = Object.assign({}, nums, {
          last_edited_by: me.id, updated_at: new Date().toISOString() });
        let entryId = existing && existing.id;
        if(entryId){
          // submitted and submitted_at are deliberately absent: saving a
          // draft never un-submits, and never submits either.
          const { error } = await admin.from('weekly_entries').update(patch).eq('id', entryId);
          if(error) return json(500,{error:'save_failed', detail:error.message});
        } else {
          const { data: made, error } = await admin.from('weekly_entries')
            .insert(Object.assign({ cycle_id:c.cycle.id, user_id:who.user_id, submitted:false }, patch))
            .select('id').single();
          if(error) return json(500,{error:'save_failed', detail:error.message});
          entryId = made && made.id;
        }
        if(!entryId) return json(500,{error:'save_failed'});
        // Replace wholesale: a source cleared on the form has to disappear,
        // which a row-by-row upsert would leave behind.
        const { error: dErr } = await admin.from('weekly_lead_rows').delete().eq('entry_id', entryId);
        if(dErr) return json(500,{error:'save_failed', detail:dErr.message});
        if(keep.length){
          const { error: iErr } = await admin.from('weekly_lead_rows')
            .insert(keep.map(r=>({ entry_id:entryId, source_id:r.source_id,
              received:r.received, sold:r.sold })));
          if(iErr) return json(500,{error:'save_failed', detail:iErr.message});
        }
        return json(200,{ ok:true, entry_id:entryId, week:c.cycle,
          user_id: who.user_id, saved_leads:keep.length });
      }
      case 'submit_week_entry': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        // Same gate as the save: a boss may finalise a line they filled in.
        const who = await weekTargetFor(me, p.target_user_id);
        if(!who.ok) return json(who.status,{error:who.error});
        const c = await currentCycle();
        if(!c.ok) return json(500,{error:c.error, detail:c.detail});
        {
          const now = weekNow();
          if(!canWriteNow(me, c.cycle, now))
            return json(403,{ error:'window_closed', window: weekWindowInfo(me, c.cycle, now) });
        }
        const { data: existing } = await admin.from('weekly_entries')
          .select('id').eq('cycle_id', c.cycle.id).eq('user_id', who.user_id).single();
        // Nothing to submit is a 404, not a silent success: the client has to
        // be able to tell "save first" from "done".
        if(!existing) return json(404,{error:'no_entry'});
        const submitted_at = new Date().toISOString();
        const { error } = await admin.from('weekly_entries')
          .update({ submitted:true, submitted_at, last_edited_by: me.id, updated_at: submitted_at })
          .eq('id', existing.id);
        if(error) return json(500,{error:'submit_failed', detail:error.message});
        // No time lock in this part: re-saving and re-submitting stay open.
        return json(200,{ ok:true, submitted:true, submitted_at, week:c.cycle,
          user_id: who.user_id });
      }
      case 'get_week_board': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        // A named cycle is history: it is read-only, whoever is asking.
        let cycle = null, isCurrent = true;
        if(p.cycle_id !== undefined && p.cycle_id !== null && p.cycle_id !== ''){
          const { data: row } = await admin.from('weekly_cycles')
            .select('id,week_start').eq('id', p.cycle_id).single();
          if(!row) return json(404,{error:'not_found'});
          const cur = await currentCycle();
          if(!cur.ok) return json(500,{error:cur.error, detail:cur.detail});
          cycle = { id: row.id, week_start: row.week_start };
          isCurrent = String(row.id) === String(cur.cycle.id);
        } else {
          const cur = await currentCycle();
          if(!cur.ok) return json(500,{error:cur.error, detail:cur.detail});
          cycle = cur.cycle; isCurrent = true;
        }
        // Exactly the Manager = LOCAL scope every other screen uses: null is
        // the whole company, otherwise the caller's subtree plus themselves.
        const ids = await scopeIdsFor(me);
        const { data: profs } = await admin.from('profiles')
          .select('id,first,last,nickname,role,role_id,campus,status');
        const inScope = (profs||[])
          .filter(u => u.status !== 'inactive')
          .filter(u => ids === null || ids.has(u.id));
        const { data: roleRows } = await admin.from('roles').select('id,name');
        const roleName = {}; (roleRows||[]).forEach(r=>{ roleName[String(r.id)] = r.name; });

        // canActOn asks the database for the whole profile list every time it
        // is called, so calling it once per member would scan the directory N
        // times. The subtree is read ONCE here and the same three branches
        // are applied; testweek2 asserts this agrees with canActOn for every
        // member of every role, so the shortcut cannot drift from the gate.
        const sub = isLocalLeader(me.role) ? await subtreeIds(me) : null;
        const mayEdit = (m) => {
          if(!isCurrent) return false;              // history is read-only
          // These are the member objects built below: the id field is
          // user_id, not id.
          if(String(m.user_id) === String(me.id)) return false;  // own line lives on the My results tab
          if(seesEverything(me.role)) return false;
          if(rank(me.role) >= ROLE_RANK.director) return outranks(me.role, m.role);
          if(isLocalLeader(me.role)) return sub.has(m.user_id) && outranks(me.role, m.role);
          return false;
        };

        const { data: sources } = await admin.from('lead_sources')
          .select('id,name,active,sort_order').eq('active', true)
          .order('sort_order',{ascending:true}).order('name',{ascending:true});
        const srcList = sources || [];

        const memberIds = inScope.map(u=>u.id);
        const { data: entries } = memberIds.length
          ? await admin.from('weekly_entries')
              .select('id,user_id,sales_dub_received,sales_dub_expected,sales_lim_received,sales_lim_expected,submitted,submitted_at,last_edited_by')
              .eq('cycle_id', cycle.id).in('user_id', memberIds)
          : { data: [] };
        const byUser = {}; (entries||[]).forEach(e=>{ byUser[String(e.user_id)] = e; });
        const entryIds = (entries||[]).map(e=>e.id);
        const { data: rows } = entryIds.length
          ? await admin.from('weekly_lead_rows').select('entry_id,source_id,received,sold').in('entry_id', entryIds)
          : { data: [] };
        const byEntry = {};
        (rows||[]).forEach(r=>{ (byEntry[String(r.entry_id)] = byEntry[String(r.entry_id)] || {})[String(r.source_id)] = r; });

        // One instant for the whole board, so two members cannot be judged
        // against clocks a few milliseconds apart.
        const boardNow = weekNow();
        const totals = { dub_received:0, dub_expected:0, lim_received:0, lim_expected:0 };
        const leadTotals = {}; srcList.forEach(s=>{ leadTotals[String(s.id)] = { received:0, sold:0 }; });

        // Field by field, never a spread: a profile row carries e-mail, phone
        // and a reporting line, none of which this board is asking for.
        const members = inScope.map(u => {
          const e = byUser[String(u.id)] || null;
          const saved = e ? (byEntry[String(e.id)] || {}) : {};
          const sales = {
            dub_received: e ? Number(e.sales_dub_received||0) : 0,
            dub_expected: e ? Number(e.sales_dub_expected||0) : 0,
            lim_received: e ? Number(e.sales_lim_received||0) : 0,
            lim_expected: e ? Number(e.sales_lim_expected||0) : 0
          };
          totals.dub_received += sales.dub_received;
          totals.dub_expected += sales.dub_expected;
          totals.lim_received += sales.lim_received;
          totals.lim_expected += sales.lim_expected;
          const leads = srcList.map(sx => {
            const r = saved[String(sx.id)];
            const received = r ? Number(r.received||0) : 0;
            const sold = r ? Number(r.sold||0) : 0;
            leadTotals[String(sx.id)].received += received;
            leadTotals[String(sx.id)].sold += sold;
            return { source_id: sx.id, name: sx.name, received, sold };
          });
          const name = [u.first, u.last].filter(Boolean).join(' ').trim() || (u.nickname||'');
          // What this person's week looks like, judged against THEIR band's
          // deadline rather than the caller's: a leader looking at an agent
          // after Thursday 15:00 should see "missed", even though the
          // leader's own window is still open.
          const theirBand = bandOf(u.role);
          const theirBounds = bandBounds(theirBand, cycle);
          let status;
          if(e && e.submitted) status = 'submitted';
          else if(!theirBand) status = 'n/a';              // the read-only tier files nothing
          else if(theirBounds.closes && boardNow.getTime() >= theirBounds.closes.getTime()) status = 'missed';
          else if(theirBounds.opens && boardNow.getTime() < theirBounds.opens.getTime()) status = 'pending';
          else if(e) status = 'draft';   // started, and still inside their window
          else status = 'none';          // nothing filed yet, and still in time
          return {
            user_id: u.id,
            status,
            name,
            cargo: roleName[String(u.role_id)] || null,
            role: u.role,
            campus: u.campus || null,
            exists: !!e,
            submitted: e ? !!e.submitted : false,
            submitted_at: e ? (e.submitted_at||null) : null,
            // Who last touched it, and whether that was somebody else. The
            // id itself is a profile id the viewer can already see on this
            // board, so there is nothing new disclosed by it.
            last_edited_by: e ? (e.last_edited_by||null) : null,
            filled_by_other: !!(e && e.last_edited_by && String(e.last_edited_by) !== String(u.id)),
            sales, leads
          };
        });
        members.sort((a,b)=> String(a.name||'').localeCompare(String(b.name||'')));

        return json(200,{
          cycle, is_current: isCurrent,
          // On a past board the caller can never write, whatever the clock
          // says about this week.
          window: isCurrent
            ? weekWindowInfo(me, cycle, boardNow)
            : Object.assign(weekWindowInfo(me, cycle, boardNow), { can_write_now:false,
                stage_label:'This week is closed' }),
          members,
          totals: Object.assign({}, totals, {
            leads: srcList.map(sx => ({ source_id: sx.id, name: sx.name,
              received: leadTotals[String(sx.id)].received,
              sold: leadTotals[String(sx.id)].sold }))
          }),
          can_edit: members.filter(m => mayEdit(m)).map(m => m.user_id)
        });
      }
      case 'list_week_cycles': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        // Make sure this week exists before listing, so the picker is never
        // missing the week the board is showing.
        const cur = await currentCycle();
        if(!cur.ok) return json(500,{error:cur.error, detail:cur.detail});
        const { data, error } = await admin.from('weekly_cycles')
          .select('id,week_start').order('week_start',{ascending:false});
        if(error) return json(500,{error:'cycles_failed', detail:error.message});
        return json(200,{ cycles: (data||[]).slice(0,26)
          .map(c=>({ id:c.id, week_start:c.week_start })),
          current_id: cur.cycle.id });
      }
      case 'set_team_target': {
        const me = await callerProfile(caller);
        if(!me) return json(403,{error:'forbidden'});
        const teamId = p.team_id;
        if(!teamId) return json(400,{error:'missing_id'});
        const team_target = numOrNull(p.team_target);
        if(team_target===false) return json(400,{error:'bad_number'});
        const { data: team } = await admin.from('teams').select('id,leader_id').eq('id',teamId).single();
        if(!team) return json(404,{error:'not_found'});
        // The company-wide AUTHORITY tiers, the team's own leader, or - new - a
        // manager, bounded to the teams inside their own branch.
        // Deliberately NOT seesWholeCompany and NOT accessibleTeamIds on their
        // own: both of those include the read-only viewer, which sees every
        // team's figures and may set none of them. The extra reads only happen
        // for a manager who does not lead the team outright, so director, admin
        // and supervisor run exactly the queries they always did.
        let maySet = rank(me.role) >= ROLE_RANK.director || team.leader_id === me.id;
        if(!maySet && isMgr(me.role)){
          const { data: scopeTeams } = await admin.from('teams').select('id,leader_id');
          const { data: scopeProfs } = await admin.from('profiles').select('id,team_id,reports_to');
          maySet = (await accessibleTeamIds(me, scopeTeams||[], scopeProfs||[])).includes(team.id);
        }
        if(!maySet) return json(403,{error:'out_of_scope'});
        const { error } = await admin.from('teams').update({ team_target }).eq('id',teamId);
        if(error) return json(500,{error:'save_failed'});
        return json(200,{ ok:true });
      }
      case 'get_teams': {
        const { data, error } = await admin.from('teams')
          .select('id,name,leader_id,campus,team_target,active').order('name',{ascending:true});
        if(error) return json(500,{error:'teams_failed'});
        return json(200,{ teams:data||[] });
      }
      case 'create_team': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const name = (p.name||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        const campus = validCampus(p.campus);
        if(campus === false) return json(400,{error:'bad_campus'});
        const team_target = numOrNull(p.team_target);
        if(team_target === false) return json(400,{error:'bad_number'});
        const leader_id = p.leader_id || null;
        if(leader_id){
          const { data: ldr } = await admin.from('profiles').select('id').eq('id',leader_id).single();
          if(!ldr) return json(404,{error:'leader_not_found'});
        }
        const { data, error } = await admin.from('teams')
          .insert({ name, leader_id, campus, team_target, active:true })
          .select('id').single();
        if(error){
          if(error.code === '23505') return json(409,{error:'name_exists'});
          return json(500,{error:'create_failed', detail:error.message});
        }
        return json(200,{ ok:true, id:data && data.id });
      }
      case 'update_team': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const id = p.id;
        if(!id) return json(400,{error:'missing_id'});
        const name = (p.name||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        const campus = validCampus(p.campus);
        if(campus === false) return json(400,{error:'bad_campus'});
        const team_target = numOrNull(p.team_target);
        if(team_target === false) return json(400,{error:'bad_number'});
        const leader_id = p.leader_id || null;
        if(leader_id){
          const { data: ldr } = await admin.from('profiles').select('id').eq('id',leader_id).single();
          if(!ldr) return json(404,{error:'leader_not_found'});
        }
        const { data: existing } = await admin.from('teams').select('id').eq('id',id).single();
        if(!existing) return json(404,{error:'not_found'});
        const { error } = await admin.from('teams')
          .update({ name, leader_id, campus, team_target, active: p.active !== false })
          .eq('id',id);
        if(error){
          if(error.code === '23505') return json(409,{error:'name_exists'});
          return json(500,{error:'update_failed', detail:error.message});
        }
        return json(200,{ ok:true });
      }
      case 'delete_team': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const id = p.id;
        if(!id) return json(400,{error:'missing_id'});
        const { data: existing } = await admin.from('teams').select('id').eq('id',id).single();
        if(!existing) return json(404,{error:'not_found'});
        const { data: members } = await admin.from('profiles').select('id').eq('team_id', id);
        if(members && members.length) return json(409,{error:'in_use', count:members.length});
        const { error } = await admin.from('teams').delete().eq('id',id);
        if(error) return json(500,{error:'delete_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      // Changing someone's cargo changes what they can DO, so it is its own
      // action with its own guards rather than a field on update_profile -
      // whose allowlist deliberately has no role or role_id in it.
      // Who someone reports to is the shape of the org chart, so it gets its
      // own action with its own guards rather than a field on update_profile -
      // whose allowlist has no reports_to in it.
      case 'set_reports_to': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        // Nobody re-parents themselves. Checked before the target is loaded, so
        // the reason is never confused with a scope failure.
        if(String(uid) === String(me.id)) return json(403,{error:'cannot_change_own_manager'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await canActOn(me, tgt)) return json(403,{error:'out_of_scope'});

        const raw = p.reports_to;
        // Clearing it puts the person at the top of the tree, which needs no
        // boss to validate.
        if(raw === null || raw === undefined || raw === ''){
          const { error } = await admin.from('profiles').update({ reports_to:null }).eq('id',uid);
          if(error) return json(500,{error:'save_failed', detail:error.message});
          return json(200,{ ok:true, reports_to:null });
        }

        const { data: boss } = await admin.from('profiles')
          .select('id,role,reports_to,status').eq('id', raw).single();
        if(!boss || boss.status === 'inactive') return json(400,{error:'bad_manager'});
        if(String(boss.id) === String(tgt.id)) return json(400,{error:'self_manager'});
        // Two separate questions. First: can this tier lead anyone at all? An
        // agent or a senior_exec cannot, whatever their rank.
        if(!LEADER_ROLES.has(boss.role)) return json(400,{error:'manager_not_leader'});
        // Second: they must be at the report's level or above. Same-rank is
        // allowed - one supervisor may run another - which is exactly why the
        // cycle walk below is now load-bearing rather than belt-and-braces.
        if(rank(boss.role) < rank(tgt.role)) return json(403,{error:'manager_not_senior'});
        // And you cannot hand out a boss who outranks you.
        if(rank(me.role) < rank(boss.role)) return json(403,{error:'forbidden'});
        // The new boss has to be inside your own branch as well, or a local
        // leader could graft their people onto a tree they do not own - and
        // lose sight of them in the same move.
        const bossScope = await scopeIdsFor(me);
        if(bossScope !== null && !bossScope.has(boss.id))
          return json(403,{error:'boss_out_of_scope'});

        // With same-rank bosses allowed, this action can now close a loop on
        // its own - A under B and then B under A, both supervisors - so the
        // walk is load-bearing, not a safety net. set_member_team also writes
        // reports_to from a team's leader with no rank check at all, which can
        // leave edges that do not climb. Walk it for real, bounded, one read.
        const { data: allRows } = await admin.from('profiles').select('id,reports_to');
        const parentOf = {};
        (allRows||[]).forEach(r=>{ parentOf[r.id] = r.reports_to; });
        let cur = boss.reports_to, hops = 0;
        while(cur != null && hops++ < 50){
          if(String(cur) === String(uid)) return json(409,{error:'would_create_cycle'});
          cur = parentOf[cur];
        }
        if(hops >= 50) return json(409,{error:'would_create_cycle'});

        const { error } = await admin.from('profiles').update({ reports_to: boss.id }).eq('id',uid);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, reports_to: boss.id });
      }
      case 'set_user_role': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        // Nobody promotes themselves, at any tier. Checked before the target is
        // even loaded, so the reason is never confused with a scope failure.
        if(String(uid) === String(me.id)) return json(403,{error:'cannot_change_own_role'});
        const { data: tgt } = await admin.from('profiles').select('id,role').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        // Two separate questions: may you act on this PERSON - rank AND, for a
        // local leader, their place in your branch - and may you hand out this
        // CARGO, which is a rank ceiling and nothing else.
        if(!await canActOn(me, tgt)) return json(403,{error:'out_of_scope'});
        if(!p.role_id) return json(400,{error:'missing_role_id'});
        const { data: cargo } = await admin.from('roles')
          .select('id,base_level,active').eq('id', p.role_id).single();
        if(!cargo) return json(404,{error:'role_not_found'});
        if(cargo.active === false) return json(400,{error:'role_inactive'});
        if(!ROLE_LEVELS.includes(cargo.base_level)) return json(400,{error:'bad_role'});
        if(!outranks(me.role, cargo.base_level)) return json(403,{error:'forbidden_role'});
        // role and role_id move together, exactly as create_user sets them.
        // team_id and reports_to are somebody else's action and stay put.
        const { error } = await admin.from('profiles')
          .update({ role: cargo.base_level, role_id: cargo.id }).eq('id',uid);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, role: cargo.base_level, role_id: cargo.id });
      }
      case 'set_member_team': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        const { data: tgt } = await admin.from('profiles').select('id,role').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await canActOn(me, tgt)) return json(403,{error:'forbidden'});
        const teamId = (p.team_id===null || p.team_id===undefined || p.team_id==='') ? null : p.team_id;
        if(teamId === null){
          // Leaving a team does not move anyone in the hierarchy.
          const { error } = await admin.from('profiles').update({ team_id:null }).eq('id',uid);
          if(error) return json(500,{error:'save_failed', detail:error.message});
          return json(200,{ ok:true });
        }
        const { data: team } = await admin.from('teams').select('id,active,leader_id').eq('id',teamId).single();
        if(!team) return json(404,{error:'team_not_found'});
        if(team.active === false) return json(400,{error:'team_inactive'});
        // The destination has to be a team the caller actually oversees. Only
        // asked of a local leader, so the company-wide tiers run exactly the
        // queries they always did.
        if(!seesWholeCompany(me.role)){
          const { data: scopeTeams } = await admin.from('teams').select('id,leader_id');
          const { data: scopeProfs } = await admin.from('profiles').select('id,team_id,reports_to');
          const okTeams = await accessibleTeamIds(me, scopeTeams||[], scopeProfs||[]);
          // An UNCLAIMED team - no leader and nobody on it - belongs to no
          // branch, so putting your own person on it discloses nothing to
          // anyone and merges their figures with nobody's. Allowed, or a local
          // leader could never populate a team created without a leader. The
          // moment it holds somebody else's person it stops being unclaimed.
          const unclaimed = team.leader_id == null
            && !(scopeProfs||[]).some(u => String(u.team_id) === String(team.id));
          if(!okTeams.includes(team.id) && !unclaimed)
            return json(403,{error:'team_out_of_scope'});
        }
        // Joining a team with a leader also lines the hierarchy up behind them -
        // but only when that leader is somebody the caller could have handed out
        // directly. A team reaches a local leader's scope through its MEMBERS as
        // well as its leader, so without this a manager could move their own
        // person onto such a team and silently re-parent them under another
        // branch's leader: the exact thing set_reports_to refuses as
        // boss_out_of_scope, through a different door. The team move still
        // happens; only the reporting line stays put, as it already does for a
        // team with no leader at all.
        const patch = { team_id: team.id };
        if(team.leader_id && team.leader_id !== uid){
          const lScope = await scopeIdsFor(me);
          if(lScope === null || lScope.has(team.leader_id)) patch.reports_to = team.leader_id;
        }
        const { error } = await admin.from('profiles').update(patch).eq('id',uid);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, reports_to: patch.reports_to || null });
      }
      case 'get_profile_detail': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        const { data: tgt } = await admin.from('profiles').select('*').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        const gates = await gatesFor(me, tgt);
        if(!gates.canView) return json(403,{error:'out_of_scope'});

        const { data: certRows } = gates.certView
          ? await admin.from('user_certs').select('cert_id,date_earned').eq('user_id',uid)
          : { data: [] };
        const { data: catalog } = await admin.from('cert_catalog').select('id,name');
        const catById = {}; (catalog||[]).forEach(c=>{ catById[c.id]=c.name; });
        const certs = (certRows||[]).map(c=>({
          id: c.cert_id, name: catById[c.cert_id] || 'Unknown certificate', date_earned: c.date_earned
        }));

        // Appraisals are never shown to their subject, director or not.
        const { data: aps } = gates.appraisal
          ? await admin.from('appraisals')
              .select('id,period,rating,notes,tags,template,responses,created_by,created_at')
              .eq('user_id',uid).order('created_at',{ascending:false})
          : { data: [] };
        const authorIds = [...new Set((aps||[]).map(a=>a.created_by).filter(Boolean))];
        const authors = {};
        if(authorIds.length){
          const { data: who } = await admin.from('profiles').select('id,first,last').in('id',authorIds);
          (who||[]).forEach(w=>{ authors[w.id] = (w.first||'')+' '+(w.last||''); });
        }
        // Field by field, like everything else that leaves here: the
        // template and the answers, and nothing a wider select might pick
        // up later.
        const appraisals = (aps||[]).map(a=>({
          id: a.id, period: a.period, rating: a.rating,
          notes: a.notes, tags: a.tags || [],
          template: a.template || null,
          responses: isResponseMap(a.responses) ? a.responses : null,
          created_by: a.created_by, created_at: a.created_at,
          created_by_name: authors[a.created_by] || null
        }));

        const { data: docs } = gates.doc
          ? await admin.from('user_documents')
              .select('id,name,category,doc_date,notes,file_url,created_at')
              .eq('user_id',uid).order('created_at',{ascending:false})
          : { data: [] };
        // The storage path never leaves the server; the client asks for a
        // signed URL when it actually wants to open a file.
        const documents = (docs||[]).map(d=>({
          id:d.id, name:d.name, category:d.category, doc_date:d.doc_date,
          notes:d.notes, created_at:d.created_at, has_file: !!d.file_url
        }));

        // Completed trainings follow certView, the same gate the certificate
        // catalogue above uses - it is the same kind of fact about a person.
        const { data: comps } = gates.certView
          ? await admin.from('training_completions')
              .select('id,content_id,cert_number,score,completed_at')
              .eq('user_id',uid).order('completed_at',{ascending:false})
          : { data: [] };
        const compIds = [...new Set((comps||[]).map(c=>c.content_id).filter(Boolean))];
        const titleById = {};
        if(compIds.length){
          const { data: items } = await admin.from('content_items').select('id,title').in('id',compIds);
          (items||[]).forEach(i=>{ titleById[i.id] = i.title; });
        }
        // Field by field, so a join can never drag a question row along.
        const training_completions = (comps||[]).map(c=>({
          id: c.id, content_id: c.content_id,
          title: titleById[c.content_id] || 'Training',
          cert_number: c.cert_number, score: c.score, completed_at: c.completed_at
        }));

        return json(200,{ profile: tgt, certs, appraisals, documents, training_completions,
          can_edit: gates.canEdit,
          can_manage_certs: gates.certManage,
          can_see_appraisals: gates.appraisal,
          can_see_documents: gates.doc });
      }
      case 'update_profile': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await canEditProfileOf(me, tgt)) return json(403,{error:'out_of_scope'});
        // Only descriptive fields. Role, email, status, reports_to, team_id and
        // targets are all managed elsewhere and are ignored here.
        const fields = p.fields || {};
        const patch = {};
        PROFILE_EDITABLE.forEach(k => {
          if(Object.prototype.hasOwnProperty.call(fields, k)){
            const v = fields[k];
            patch[k] = (v===null || v===undefined) ? null : String(v).trim();
          }
        });
        if(Object.prototype.hasOwnProperty.call(fields, 'languages')){
          const ls = normLanguages(fields.languages);
          if(!ls.ok) return json(400,{error:ls.error});
          patch.languages = ls.value;
        }
        for(const bk of Object.keys(BIRTH_RANGE)){
          if(!Object.prototype.hasOwnProperty.call(fields, bk)) continue;
          const bp = normBirthPart(bk, fields[bk]);
          if(!bp.ok) return json(400,{error:'bad_birthday'});
          patch[bk] = bp.value;
        }
        if(Object.prototype.hasOwnProperty.call(fields, 'start_date')){
          // Refused up front, before the single .update(patch) below, so a
          // forged start_date cannot carry other field writes in with it.
          if(!allowStart(me, uid)) return json(403,{error:'start_date_forbidden'});
          const sd = normStartDate(fields.start_date);
          if(!sd.ok) return json(400,{error:'bad_start_date'});
          patch.start_date = sd.value;
        }
        if(!Object.keys(patch).length) return json(400,{error:'nothing_to_update'});
        if(patch.first !== undefined && patch.first === '') return json(400,{error:'name_required'});
        if(patch.last !== undefined && patch.last === '') return json(400,{error:'name_required'});
        const { error } = await admin.from('profiles').update(patch).eq('id',uid);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, updated: Object.keys(patch) });
      }
      case 'upload_avatar': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await canEditProfileOf(me, tgt)) return json(403,{error:'out_of_scope'});
        const b64 = (p.data_base64 || '').replace(/^data:[^;]+;base64,/, '');
        if(!b64) return json(400,{error:'missing_image'});
        let buf;
        try { buf = Buffer.from(b64, 'base64'); } catch(e){ return json(400,{error:'bad_image'}); }
        if(!buf.length) return json(400,{error:'bad_image'});
        if(buf.length > 2*1024*1024) return json(413,{error:'image_too_large'});
        const path = uid + '.jpg';
        const { error: upErr } = await admin.storage.from('avatars')
          .upload(path, buf, { contentType: p.content_type || 'image/jpeg', upsert: true });
        if(upErr) return json(500,{error:'upload_failed', detail:upErr.message});
        const { data: pub } = admin.storage.from('avatars').getPublicUrl(path);
        const photo = (pub && pub.publicUrl ? pub.publicUrl : '') + '?v=' + Date.now();
        const { error } = await admin.from('profiles').update({ photo }).eq('id',uid);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, photo });
      }
      case 'get_cert_catalog': {
        let { data: rows } = await admin.from('cert_catalog').select('id,name').order('name',{ascending:true});
        if(!rows || !rows.length){
          await admin.from('cert_catalog').insert(CERT_SEED.map(name=>({ name })));
          const seeded = await admin.from('cert_catalog').select('id,name').order('name',{ascending:true});
          rows = seeded.data || [];
        }
        return json(200,{ catalog: rows });
      }
      case 'add_user_cert': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const uid = p.user_id, certId = p.cert_id;
        if(!uid || !certId) return json(400,{error:'missing_id'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!(await gatesFor(me,tgt)).certManage) return json(403,{error:'out_of_scope'});
        const { data: course } = await admin.from('cert_catalog').select('id').eq('id',certId).single();
        if(!course) return json(404,{error:'cert_not_found'});
        const { error } = await admin.from('user_certs')
          .upsert({ user_id:uid, cert_id:certId, date_earned: p.date_earned || null },
                  { onConflict:'user_id,cert_id' });
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      case 'remove_user_cert': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const uid = p.user_id, certId = p.cert_id;
        if(!uid || !certId) return json(400,{error:'missing_id'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!(await gatesFor(me,tgt)).certManage) return json(403,{error:'out_of_scope'});
        const { error } = await admin.from('user_certs').delete().eq('user_id',uid).eq('cert_id',certId);
        if(error) return json(500,{error:'delete_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      case 'add_cert_catalog': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const name = (p.name||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        const { data, error } = await admin.from('cert_catalog').insert({ name }).select('id,name').single();
        if(error){
          if(error.code === '23505') return json(409,{error:'name_exists'});
          return json(500,{error:'save_failed', detail:error.message});
        }
        return json(200,{ ok:true, cert:data });
      }
      case 'create_appraisal': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!(await gatesFor(me,tgt)).appraisal) return json(403,{error:'out_of_scope'});
        const period = (p.period||'').toString().trim();
        const template = (p.template||'').toString();
        if(!period) return json(400,{error:'missing_period'});
        if(!APPRAISAL_TEMPLATES.includes(template)) return json(400,{error:'bad_template'});
        if(!isResponseMap(p.responses)) return json(400,{error:'bad_responses'});
        const rating = appraisalRating(p.overall_rating);
        if(!rating.ok) return json(400,{error:'bad_rating'});
        const { data, error } = await admin.from('appraisals').insert({
          user_id: uid, template, period, rating: rating.value, responses: p.responses,
          notes: (p.notes||'').toString(),
          tags: Array.isArray(p.tags) ? p.tags : [],
          created_by: me.id, created_at: new Date().toISOString()
        }).select('id').single();
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, id:data && data.id });
      }
      case 'update_appraisal': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('appraisals').select('id,user_id').eq('id',p.id).single();
        if(!row) return json(404,{error:'not_found'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',row.user_id).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!(await gatesFor(me,tgt)).appraisal) return json(403,{error:'out_of_scope'});
        const period = (p.period||'').toString().trim();
        const template = (p.template||'').toString();
        if(!period) return json(400,{error:'missing_period'});
        if(!APPRAISAL_TEMPLATES.includes(template)) return json(400,{error:'bad_template'});
        if(!isResponseMap(p.responses)) return json(400,{error:'bad_responses'});
        const rating = appraisalRating(p.overall_rating);
        if(!rating.ok) return json(400,{error:'bad_rating'});
        // Only what the form owns. An appraisal written before templates
        // existed keeps its notes and tags rather than losing them to a
        // form that has nowhere to show them.
        const { error } = await admin.from('appraisals').update({
          template, period, rating: rating.value, responses: p.responses
        }).eq('id',p.id);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      case 'delete_appraisal': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('appraisals').select('id,user_id').eq('id',p.id).single();
        if(!row) return json(404,{error:'not_found'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',row.user_id).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!(await gatesFor(me,tgt)).appraisal) return json(403,{error:'out_of_scope'});
        const { error } = await admin.from('appraisals').delete().eq('id',p.id);
        if(error) return json(500,{error:'delete_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      case 'upload_document': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!(await gatesFor(me,tgt)).doc) return json(403,{error:'out_of_scope'});
        const name = (p.name||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        const b64 = (p.data_base64||'').replace(/^data:[^;]+;base64,/,'');
        if(!b64) return json(400,{error:'missing_file'});
        let buf;
        try { buf = Buffer.from(b64,'base64'); } catch(e){ return json(400,{error:'bad_file'}); }
        if(!buf.length) return json(400,{error:'bad_file'});
        // Netlify caps a synchronous request body around 6MB and base64 adds
        // about a third, so the raw file has to stay under 4MB.
        if(buf.length > 4*1024*1024) return json(413,{error:'file_too_large'});
        const category = DOC_CATEGORIES.includes(p.category) ? p.category : 'Other';
        const path = uid + '/' + require('crypto').randomUUID() + '_' + safeFileName(p.filename || name);
        const { error: upErr } = await admin.storage.from('documents')
          .upload(path, buf, { contentType: p.content_type || 'application/octet-stream', upsert: false });
        if(upErr) return json(500,{error:'upload_failed', detail:upErr.message});
        const { data, error } = await admin.from('user_documents').insert({
          user_id: uid, name, category, doc_date: p.doc_date || null,
          notes: (p.notes||'').toString(), file_url: path,
          created_at: new Date().toISOString()
        }).select('id,name,category,doc_date,notes,created_at').single();
        if(error){
          await admin.storage.from('documents').remove([path]);
          return json(500,{error:'save_failed', detail:error.message});
        }
        // Built field by field: the storage path must never reach the client,
        // and that must not depend on the select projection.
        return json(200,{ ok:true, document: {
          id: data.id, name: data.name, category: data.category,
          doc_date: data.doc_date, notes: data.notes, created_at: data.created_at,
          has_file: true
        } });
      }
      case 'get_document_url': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.doc_id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('user_documents').select('id,user_id,file_url').eq('id',p.doc_id).single();
        if(!row) return json(404,{error:'not_found'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',row.user_id).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!(await gatesFor(me,tgt)).doc) return json(403,{error:'out_of_scope'});
        if(!row.file_url) return json(404,{error:'no_file'});
        const { data, error } = await admin.storage.from('documents').createSignedUrl(row.file_url, 60);
        if(error || !data) return json(500,{error:'sign_failed', detail:error && error.message});
        return json(200,{ ok:true, url:data.signedUrl });
      }
      case 'delete_document': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.doc_id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('user_documents').select('id,user_id,file_url').eq('id',p.doc_id).single();
        if(!row) return json(404,{error:'not_found'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',row.user_id).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!(await gatesFor(me,tgt)).doc) return json(403,{error:'out_of_scope'});
        if(row.file_url) await admin.storage.from('documents').remove([row.file_url]);
        const { error } = await admin.from('user_documents').delete().eq('id',p.doc_id);
        if(error) return json(500,{error:'delete_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      // ── CONTENT LIBRARY ──────────────────────────────────────
      // Reading is everyone's; every write is isMgr. Nothing here consults
      // the branch scope: a training is published to the company, not to a
      // reporting line, so Manager = LOCAL deliberately does not apply.
      case 'get_content': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        let q = admin.from('content_items')
          .select('id,type,title,description,category,cover_url,file_path,file_name,file_type,link_url,pinned,has_test,pass_threshold,sort_order,created_at')
          .eq('active', true);
        // A library is browsed; a news feed is read. Updates therefore order
        // pinned-first then newest-first, and every other type keeps the
        // hand-set order it has always had. The branch is on the REQUESTED
        // type, so an unfiltered call - which mixes types - keeps the
        // original ordering rather than quietly re-sorting the library.
        const newestFirst = (p.type === 'update');
        if(newestFirst){
          q = q.order('pinned',{ascending:false}).order('created_at',{ascending:false});
        } else {
          q = q.order('sort_order',{ascending:true}).order('created_at',{ascending:true});
        }
        if(p.type !== undefined && p.type !== null && p.type !== ''){
          if(!CONTENT_TYPES.includes(p.type)) return json(400,{error:'bad_type'});
          q = q.eq('type', p.type);
        }
        const { data, error } = await q;
        if(error) return json(500,{error:'content_failed', detail:error.message});
        // Field by field. file_path is the key to a private bucket and must
        // never reach a browser - and that must not depend on somebody
        // remembering to prune the select above.
        return json(200,{ items:(data||[]).map(r=>({
          id: r.id, type: r.type, title: r.title,
          description: r.description, category: r.category,
          cover_url: r.cover_url, file_name: r.file_name, file_type: r.file_type,
          has_file: !!r.file_path,
          // Unlike file_path, this one IS the destination: a public address
          // the card turns into an href, so it goes out in full. It was
          // sanitised on the way in, and is re-checked on the way out
          // because a row can also be edited outside this gateway.
          link_url: safeHttpUrl(r.link_url),
          pinned: !!r.pinned,
          // Both are public by nature: a card has to be able to say "test
          // required, 70% to pass". Neither says anything about the answers.
          has_test: !!r.has_test,
          pass_threshold: (r.pass_threshold===null||r.pass_threshold===undefined) ? null : Number(r.pass_threshold),
          sort_order: r.sort_order, created_at: r.created_at
        })) });
      }
      case 'content_upload_url': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const bucket = CONTENT_BUCKETS[p.bucket];
        if(!bucket) return json(400,{error:'bad_bucket'});
        // Random prefix, sanitised name: two uploads of "notes.pdf" cannot
        // collide, and nothing in a filename can climb out of the bucket.
        const path = require('crypto').randomUUID() + '_' + safeFileName(p.filename);
        const { data, error } = await admin.storage.from(bucket).createSignedUploadUrl(path);
        if(error || !data) return json(500,{error:'sign_failed', detail:error && error.message});
        // The browser PUTs straight to Storage with this, so the bytes never
        // pass through the function body - which is the whole point: Netlify
        // caps a synchronous request around 6MB, as upload_document notes.
        const out = { ok:true, bucket, path: data.path || path, token: data.token, signed_url: data.signedUrl };
        // A cover is public by design, and its URL is what lands on the row.
        if(p.bucket === 'cover'){
          const { data: pub } = admin.storage.from(bucket).getPublicUrl(path);
          out.public_url = (pub && pub.publicUrl) || '';
        }
        return json(200, out);
      }
      case 'create_content': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        if(!CONTENT_TYPES.includes(p.type)) return json(400,{error:'bad_type'});
        const title = (p.title||'').toString().trim();
        if(!title) return json(400,{error:'missing_title'});
        const { data, error } = await admin.from('content_items').insert({
          type: p.type, title,
          description: (p.description||'').toString(),
          category: (p.category||'').toString().trim() || null,
          cover_url: p.cover_url || null,
          file_path: p.file_path || null,
          file_name: p.file_name || null,
          file_type: p.file_type || null,
          // Sanitised here rather than trusted: whatever the client sends,
          // what lands on the row is an http(s) URL or nothing at all.
          link_url: safeHttpUrl(p.link_url),
          pinned: !!p.pinned,
          sort_order: Number.isFinite(Number(p.sort_order)) ? Number(p.sort_order) : 0,
          // Never from the request. A test is attached afterwards, by
          // save_training_test, which is the only action that may set these -
          // so no payload can publish an item that claims to have a test.
          has_test: false, pass_threshold: null,
          active: true, created_by: me.id
        }).select('id').single();
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, id: data.id });
      }
      case 'update_content': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('content_items')
          .select('id,cover_url,file_path').eq('id',p.id).single();
        if(!row) return json(404,{error:'not_found'});
        const patch = {};
        if(p.type !== undefined){
          if(!CONTENT_TYPES.includes(p.type)) return json(400,{error:'bad_type'});
          patch.type = p.type;
        }
        if(p.title !== undefined){
          const t = (p.title||'').toString().trim();
          if(!t) return json(400,{error:'missing_title'});
          patch.title = t;
        }
        if(p.description !== undefined) patch.description = (p.description||'').toString();
        if(p.category !== undefined) patch.category = (p.category||'').toString().trim() || null;
        // safeHttpUrl('') is null, so clearing the field clears the column.
        if(p.link_url !== undefined) patch.link_url = safeHttpUrl(p.link_url);
        if(p.pinned !== undefined) patch.pinned = !!p.pinned;
        if(p.sort_order !== undefined && Number.isFinite(Number(p.sort_order))) patch.sort_order = Number(p.sort_order);
        if(p.active !== undefined) patch.active = !!p.active;
        // A replaced cover or file leaves its predecessor in the bucket unless
        // it is removed here, because nothing else ever will.
        let staleCover = null, staleFile = null;
        if(p.cover_url !== undefined){
          patch.cover_url = p.cover_url || null;
          if(row.cover_url && row.cover_url !== patch.cover_url) staleCover = row.cover_url;
        }
        if(p.file_path !== undefined){
          patch.file_path = p.file_path || null;
          patch.file_name = p.file_name || null;
          patch.file_type = p.file_type || null;
          if(row.file_path && row.file_path !== patch.file_path) staleFile = row.file_path;
        }
        if(!Object.keys(patch).length) return json(400,{error:'nothing_to_update'});
        const { error } = await admin.from('content_items').update(patch).eq('id',p.id);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        // Only once the row is safely updated: an orphaned object is waste, a
        // missing object under a live row is a broken item.
        if(staleFile) await admin.storage.from(CONTENT_BUCKETS.file).remove([staleFile]);
        if(staleCover){
          const op = coverObjectPath(staleCover);
          if(op) await admin.storage.from(CONTENT_BUCKETS.cover).remove([op]);
        }
        return json(200,{ ok:true });
      }
      case 'delete_content': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('content_items')
          .select('id,cover_url,file_path').eq('id',p.id).single();
        if(!row) return json(404,{error:'not_found'});
        // Objects first: a row deleted while its objects survive leaves two
        // files nothing can ever reach again.
        if(row.file_path) await admin.storage.from(CONTENT_BUCKETS.file).remove([row.file_path]);
        if(row.cover_url){
          const op = coverObjectPath(row.cover_url);
          if(op) await admin.storage.from(CONTENT_BUCKETS.cover).remove([op]);
        }
        const { error } = await admin.from('content_items').delete().eq('id',p.id);
        if(error) return json(500,{error:'delete_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      case 'get_content_file_url': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('content_items')
          .select('id,file_path').eq('id',p.id).single();
        if(!row) return json(404,{error:'not_found'});
        if(!row.file_path) return json(404,{error:'no_file'});
        // Opening is everyone's, per the library's rule - being signed in is
        // the whole gate. The path still never leaves the server; only a URL
        // that stops working in a minute does.
        const { data, error } = await admin.storage.from(CONTENT_BUCKETS.file).createSignedUrl(row.file_path, 60);
        if(error || !data) return json(500,{error:'sign_failed', detail:error && error.message});
        return json(200,{ ok:true, url: data.signedUrl });
      }
      // ── TRAINING TESTS: authoring (isMgr) ────────────────────
      case 'save_training_test': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        if(!p.content_id) return json(400,{error:'missing_id'});
        const t = await trainingRow(p.content_id);
        if(!t.ok) return json(t.status,{error:t.error});
        const hasTest = !!p.has_test;
        let threshold = null, questions = null;
        if(hasTest){
          threshold = Number(p.pass_threshold);
          if(!Number.isInteger(threshold) || threshold < 1 || threshold > 100)
            return json(400,{error:'bad_threshold'});
          const v = validateQuestions(p.questions);
          if(!v.ok) return json(400,{error:v.error});
          questions = v.value;
        } else if(Array.isArray(p.questions)){
          // Turning the test off while sending a list means "clear it".
          questions = [];
        }
        const { error: upErr } = await admin.from('content_items')
          .update({ has_test: hasTest, pass_threshold: hasTest ? threshold : null })
          .eq('id', p.content_id);
        if(upErr) return json(500,{error:'save_failed', detail:upErr.message});
        // Replace wholesale. Editing in place would have to match rows up by
        // identity, and a question whose text changed is a different question.
        if(questions !== null){
          const { error: delErr } = await admin.from('training_questions').delete().eq('content_id', p.content_id);
          if(delErr) return json(500,{error:'save_failed', detail:delErr.message});
          if(questions.length){
            const { error: insErr } = await admin.from('training_questions')
              .insert(questions.map(q => ({ content_id: p.content_id, question: q.question,
                options: q.options, correct_index: q.correct_index, sort_order: q.sort_order })));
            if(insErr) return json(500,{error:'save_failed', detail:insErr.message});
          }
        }
        return json(200,{ ok:true, has_test: hasTest, pass_threshold: hasTest ? threshold : null,
          question_count: questions === null ? null : questions.length });
      }
      case 'get_training_admin': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        if(!p.content_id) return json(400,{error:'missing_id'});
        const t = await trainingRow(p.content_id);
        if(!t.ok) return json(t.status,{error:t.error});
        const { data: qs, error } = await admin.from('training_questions')
          .select('id,question,options,correct_index,sort_order')
          .eq('content_id', p.content_id)
          .order('sort_order',{ascending:true}).order('id',{ascending:true});
        if(error) return json(500,{error:'load_failed', detail:error.message});
        // The ONE response on this gateway that carries correct_index, and it
        // is behind isMgr. Authoring needs it; nothing else may have it.
        return json(200,{ ok:true, content_id: t.row.id, title: t.row.title,
          has_test: !!t.row.has_test,
          pass_threshold: (t.row.pass_threshold===null||t.row.pass_threshold===undefined) ? null : Number(t.row.pass_threshold),
          questions: (qs||[]).map(q=>({ id:q.id, question:q.question,
            options: Array.isArray(q.options) ? q.options : [],
            correct_index: q.correct_index, sort_order: q.sort_order })) });
      }
      // ── TRAINING TESTS: taking (any signed-in caller) ────────
      case 'get_test': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.content_id) return json(400,{error:'missing_id'});
        const t = await trainingRow(p.content_id);
        if(!t.ok) return json(t.status,{error:t.error});
        if(!t.row.has_test) return json(404,{error:'no_test'});
        // correct_index is NOT in this select. Not fetched, so not forgotten.
        const { data: qs, error } = await admin.from('training_questions')
          .select('id,question,options,sort_order')
          .eq('content_id', p.content_id)
          .order('sort_order',{ascending:true}).order('id',{ascending:true});
        if(error) return json(500,{error:'load_failed', detail:error.message});
        if(!(qs||[]).length) return json(404,{error:'no_questions'});
        const mine = await myTrainingStatus(me.id, p.content_id);
        return json(200,{ ok:true, content_id: t.row.id, title: t.row.title,
          pass_threshold: Number(t.row.pass_threshold),
          question_count: qs.length,
          questions: qs.map(q=>({ id:q.id, question:q.question,
            options: Array.isArray(q.options) ? q.options : [] })),
          best_score: mine.best_score, attempts: mine.attempts,
          passed: mine.passed, cert_number: mine.cert_number,
          completion_id: mine.completion_id, completed_at: mine.completed_at });
      }
      case 'submit_test': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.content_id) return json(400,{error:'missing_id'});
        const t = await trainingRow(p.content_id);
        if(!t.ok) return json(t.status,{error:t.error});
        if(!t.row.has_test) return json(404,{error:'no_test'});
        const answers = (p.answers && typeof p.answers === 'object' && !Array.isArray(p.answers)) ? p.answers : null;
        if(!answers) return json(400,{error:'bad_answers'});
        // Grading happens here and only here. The client sent indices; it has
        // never been told which index is right.
        const { data: qs, error } = await admin.from('training_questions')
          .select('id,correct_index').eq('content_id', p.content_id);
        if(error) return json(500,{error:'load_failed', detail:error.message});
        const total = (qs||[]).length;
        if(!total) return json(404,{error:'no_questions'});
        let correct = 0;
        (qs||[]).forEach(q => {
          const given = answers[String(q.id)];
          if(given === undefined || given === null) return;
          if(Number(given) === Number(q.correct_index)) correct++;
        });
        const threshold = Number(t.row.pass_threshold);
        const score = Math.round(correct / total * 100);
        const passed = score >= threshold;
        // Every attempt is recorded, pass or fail - unlimited retries are the
        // decision, an unlogged attempt is not.
        const { error: aErr } = await admin.from('training_attempts').insert({
          user_id: me.id, content_id: p.content_id, score, passed, answers });
        if(aErr) return json(500,{error:'save_failed', detail:aErr.message});
        // Score and totals only. No per-question result: with unlimited
        // retries, telling someone WHICH ones they missed hands over the
        // answer key in a single attempt.
        const out = { ok:true, score, passed, correct, total, pass_threshold: threshold };
        if(!passed) return json(200, out);

        const existing = await myTrainingStatus(me.id, p.content_id);
        if(existing.completion_id){
          // unique(user_id,content_id): the first pass is the one that counts,
          // and a later better score does not re-mint a certificate.
          out.cert_number = existing.cert_number;
          out.completion_id = existing.completion_id;
          out.completed_at = existing.completed_at;
          out.already_completed = true;
          return json(200, out);
        }
        const year = new Date().getFullYear();
        for(let i=0;i<CERT_MINT_TRIES;i++){
          const { data: taken } = await admin.from('training_completions').select('cert_number');
          const cert = certNumberFor(year, (taken||[]).map(r=>r.cert_number));
          const { data: made, error: cErr } = await admin.from('training_completions')
            .insert({ user_id: me.id, content_id: p.content_id, cert_number: cert, score })
            .select('id,cert_number,completed_at').single();
          if(!cErr && made){
            out.cert_number = made.cert_number || cert;
            out.completion_id = made.id;
            out.completed_at = made.completed_at || null;
            return json(200, out);
          }
          const code = cErr && (cErr.code || '');
          if(code !== '23505') return json(500,{error:'save_failed', detail:cErr && cErr.message});
          // Either somebody took this cert_number between the count and the
          // insert - retry - or this person already has a completion for this
          // training, in which case theirs is the answer.
          const again = await myTrainingStatus(me.id, p.content_id);
          if(again.completion_id){
            out.cert_number = again.cert_number;
            out.completion_id = again.completion_id;
            out.completed_at = again.completed_at;
            out.already_completed = true;
            return json(200, out);
          }
        }
        return json(500,{error:'cert_mint_failed'});
      }
      case 'get_my_training_status': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(p.content_id){
          const t = await trainingRow(p.content_id);
          if(!t.ok) return json(t.status,{error:t.error});
          const mine = await myTrainingStatus(me.id, p.content_id);
          return json(200,{ ok:true, items:[ Object.assign({ content_id: t.row.id,
            has_test: !!t.row.has_test,
            pass_threshold: (t.row.pass_threshold===null||t.row.pass_threshold===undefined) ? null : Number(t.row.pass_threshold)
          }, mine) ] });
        }
        const { data: rows } = await admin.from('content_items')
          .select('id,has_test,pass_threshold').eq('type','training').eq('has_test', true);
        const items = [];
        for(const r of (rows||[])){
          const mine = await myTrainingStatus(me.id, r.id);
          items.push(Object.assign({ content_id: r.id, has_test: true,
            pass_threshold: (r.pass_threshold===null||r.pass_threshold===undefined) ? null : Number(r.pass_threshold)
          }, mine));
        }
        return json(200,{ ok:true, items });
      }
      case 'get_certificate': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.completion_id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('training_completions')
          .select('id,user_id,content_id,cert_number,score,completed_at').eq('id',p.completion_id).single();
        if(!row) return json(404,{error:'not_found'});
        // Yours, or a profile you are allowed to look at. certView is the same
        // predicate as canView, so the read-only company-wide tier can see a
        // certificate exactly where it can already see the profile.
        if(String(row.user_id) !== String(me.id)){
          const { data: owner } = await admin.from('profiles').select('id,role,reports_to').eq('id',row.user_id).single();
          if(!owner) return json(404,{error:'not_found'});
          if(!(await gatesFor(me, owner)).certView) return json(403,{error:'out_of_scope'});
        }
        const { data: who } = await admin.from('profiles').select('id,first,last,job_title').eq('id',row.user_id).single();
        const { data: item } = await admin.from('content_items').select('id,title').eq('id',row.content_id).single();
        return json(200,{ ok:true,
          completion_id: row.id,
          cert_number: row.cert_number,
          score: row.score,
          completed_at: row.completed_at,
          training: { id: row.content_id, title: (item && item.title) || 'Training' },
          person: { id: row.user_id, first: (who && who.first) || '',
            last: (who && who.last) || '', job_title: (who && who.job_title) || '' } });
      }
      case 'list_meetings': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const now = new Date();
        const year = Number(p.year) || now.getFullYear();
        const month = Number(p.month) || (now.getMonth()+1);
        if(!(month>=1 && month<=12) || !(year>=2000 && year<=2100)) return json(400,{error:'bad_input'});
        const from = year + '-' + String(month).padStart(2,'0') + '-01';
        const lastDay = new Date(year, month, 0).getDate();
        const to = year + '-' + String(month).padStart(2,'0') + '-' + String(lastDay).padStart(2,'0');

        const { data: mine } = await admin.from('meeting_attendees').select('meeting_id').eq('user_id', me.id);
        const attendingIds = [...new Set((mine||[]).map(a=>a.meeting_id))];
        const { data: rows, error } = await admin.from('meetings')
          .select('*').gte('meeting_date', from).lte('meeting_date', to);
        if(error) return json(500,{error:'list_failed', detail:error.message});
        const visible = (rows||[]).filter(m => m.created_by === me.id || attendingIds.includes(m.id));
        const { data: locs } = await admin.from('locations').select('id,name');
        const locationsById = {}; (locs||[]).forEach(l=>{ locationsById[l.id]=l.name; });
        const out = [];
        for(const m of visible){
          out.push(meetingForCaller(m, await attendeeIdsOf(m.id, m.created_by), me, locationsById));
        }
        out.sort((a,b)=> String(a.meeting_date).localeCompare(String(b.meeting_date))
                      || String(a.meeting_time||'').localeCompare(String(b.meeting_time||'')));
        return json(200,{ year, month, meetings: out });
      }
      case 'create_meeting': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const title = (p.title||'').toString().trim();
        const meeting_date = (p.meeting_date||'').toString().trim();
        if(!title) return json(400,{error:'missing_title'});
        if(!/^\d{4}-\d{2}-\d{2}$/.test(meeting_date)) return json(400,{error:'bad_date'});
        const duration = Number(p.duration);
        // Online and a physical location are mutually exclusive.
        const online = !!p.is_online;
        let locationId = null;
        if(!online){
          const loc = await resolveLocation(p.location_id);
          if(!loc.ok) return json(400,{error:loc.error});
          locationId = loc.id;
        }
        const { data, error } = await admin.from('meetings').insert({
          title, meeting_date,
          meeting_time: (p.meeting_time||'09:00').toString(),
          duration: (Number.isFinite(duration) && duration > 0) ? duration : 60,
          type: (p.type === 'call') ? 'call' : 'meeting',
          location: (p.location||'').toString(),
          location_id: locationId,
          is_online: online,
          jitsi_room: online ? newJitsiRoom() : null,
          notes: (p.notes||'').toString(),
          minutes: '',
          minutes_private: !!p.minutes_private,
          created_by: me.id,
          created_at: new Date().toISOString()
        }).select('id').single();
        if(error) return json(500,{error:'save_failed', detail:error.message});
        const id = data && data.id;
        const ids = [...new Set([me.id, ...(Array.isArray(p.attendee_ids) ? p.attendee_ids : [])])];
        const { error: aErr } = await admin.from('meeting_attendees')
          .insert(ids.map(uid=>({ meeting_id:id, user_id:uid })));
        if(aErr){
          await admin.from('meetings').delete().eq('id', id);
          return json(500,{error:'attendees_failed', detail:aErr.message});
        }
        return json(200,{ ok:true, id });
      }
      case 'update_meeting': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: m } = await admin.from('meetings').select('id,created_by,is_online,jitsi_room').eq('id',p.id).single();
        if(!m) return json(404,{error:'not_found'});
        if(!canManageMeeting(me, m)) return json(403,{error:'out_of_scope'});
        const patch = {};
        if(Object.prototype.hasOwnProperty.call(p,'is_online') || Object.prototype.hasOwnProperty.call(p,'location_id')){
          const online = Object.prototype.hasOwnProperty.call(p,'is_online') ? !!p.is_online : !!m.is_online;
          patch.is_online = online;
          if(online){
            patch.location_id = null;
            // Keep the existing room so links already shared keep working.
            if(!m.jitsi_room) patch.jitsi_room = newJitsiRoom();
          } else {
            const loc = await resolveLocation(p.location_id);
            if(!loc.ok) return json(400,{error:loc.error});
            patch.location_id = loc.id;
            // The old room stays on the row but is no longer handed out.
          }
        }
        MEETING_EDITABLE.forEach(k=>{
          if(!Object.prototype.hasOwnProperty.call(p, k)) return;
          if(k === 'duration'){ const n = Number(p[k]); if(Number.isFinite(n) && n > 0) patch[k] = n; return; }
          if(k === 'minutes_private'){ patch[k] = !!p[k]; return; }
          if(k === 'type'){ patch[k] = (p[k] === 'call') ? 'call' : 'meeting'; return; }
          patch[k] = (p[k]===null||p[k]===undefined) ? null : String(p[k]).trim();
        });
        if(patch.title !== undefined && patch.title === '') return json(400,{error:'missing_title'});
        if(patch.meeting_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(patch.meeting_date)) return json(400,{error:'bad_date'});
        if(!Object.keys(patch).length) return json(400,{error:'nothing_to_update'});
        const { error } = await admin.from('meetings').update(patch).eq('id',p.id);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, updated:Object.keys(patch) });
      }
      case 'delete_meeting': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: m } = await admin.from('meetings').select('id,created_by').eq('id',p.id).single();
        if(!m) return json(404,{error:'not_found'});
        if(!canManageMeeting(me, m)) return json(403,{error:'out_of_scope'});
        await admin.from('meeting_attendees').delete().eq('meeting_id',p.id);
        const { error } = await admin.from('meetings').delete().eq('id',p.id);
        if(error) return json(500,{error:'delete_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      case 'set_attendees': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: m } = await admin.from('meetings').select('id,created_by').eq('id',p.id).single();
        if(!m) return json(404,{error:'not_found'});
        if(!canManageMeeting(me, m)) return json(403,{error:'out_of_scope'});
        // The organiser always stays on their own meeting.
        const ids = [...new Set([m.created_by, ...(Array.isArray(p.attendee_ids) ? p.attendee_ids : [])])];
        await admin.from('meeting_attendees').delete().eq('meeting_id',p.id);
        const { error } = await admin.from('meeting_attendees')
          .insert(ids.map(uid=>({ meeting_id:p.id, user_id:uid })));
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, attendees:ids });
      }
      case 'save_minutes': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: m } = await admin.from('meetings').select('id,created_by').eq('id',p.id).single();
        if(!m) return json(404,{error:'not_found'});
        // Writing minutes is the organiser's alone, private or not.
        if(m.created_by !== me.id) return json(403,{error:'out_of_scope'});
        const { error } = await admin.from('meetings')
          .update({ minutes: (p.minutes||'').toString() }).eq('id',p.id);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      case 'get_locations': {
        const { data, error } = await admin.from('locations')
          .select('id,name,campus,active').order('name',{ascending:true});
        if(error) return json(500,{error:'locations_failed'});
        return json(200,{ locations:data||[] });
      }
      case 'create_location': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const name = (p.name||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        const campus = validCampus(p.campus);
        if(campus === false) return json(400,{error:'bad_campus'});
        const { data, error } = await admin.from('locations')
          .insert({ name, campus, active:true }).select('id').single();
        if(error){
          if(error.code === '23505') return json(409,{error:'name_exists'});
          return json(500,{error:'create_failed', detail:error.message});
        }
        return json(200,{ ok:true, id:data && data.id });
      }
      case 'update_location': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const name = (p.name||'').toString().trim();
        if(!name) return json(400,{error:'missing_name'});
        const campus = validCampus(p.campus);
        if(campus === false) return json(400,{error:'bad_campus'});
        const { data: existing } = await admin.from('locations').select('id').eq('id',p.id).single();
        if(!existing) return json(404,{error:'not_found'});
        const { error } = await admin.from('locations')
          .update({ name, campus, active: p.active !== false }).eq('id',p.id);
        if(error){
          if(error.code === '23505') return json(409,{error:'name_exists'});
          return json(500,{error:'update_failed', detail:error.message});
        }
        return json(200,{ ok:true });
      }
      case 'delete_location': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: existing } = await admin.from('locations').select('id').eq('id',p.id).single();
        if(!existing) return json(404,{error:'not_found'});
        const { data: used } = await admin.from('meetings').select('id').eq('location_id',p.id);
        if(used && used.length) return json(409,{error:'in_use', count:used.length});
        const { error } = await admin.from('locations').delete().eq('id',p.id);
        if(error) return json(500,{error:'delete_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      // ── HOLIDAYS / TIME OFF ──────────────────────────────────
      case 'get_holiday_overview': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const year = holidayYear();
        const balance = await holidayBalance(me.id, year);
        const { data: rows } = await admin.from('holiday_requests')
          .select('id,user_id,type,start_date,end_date,working_days,note,status,decided_at,decision_note,created_at')
          .eq('user_id', me.id);
        const mine = (rows || []).filter(r => String(r.start_date || '').slice(0,4) === String(year));
        // Newest first, whatever their state: this is your own list, so a
        // pending row does not deserve to jump above a decided one.
        const requests = mine.slice()
          .sort((a,b) => (String(b.created_at||'')+'|'+String(b.id))
            .localeCompare(String(a.created_at||'')+'|'+String(a.id)))
          .map(holidayRequestOut);
        return json(200,{ year, balance, requests, types: HOLIDAY_TYPES });
      }
      case 'create_holiday_request': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        // Always the caller's own row: there is no target_user_id here, so
        // nobody can book time off in somebody else's name.
        const type = String(p.type == null ? '' : p.type);
        if(!HOLIDAY_TYPES.includes(type)) return json(400,{error:'bad_type'});
        const days = workingDays(p.start_date, p.end_date);
        if(days === false) return json(400,{error:'bad_dates'});
        // A weekend parses perfectly well and is worth nothing, which is a
        // different mistake from an unreadable date.
        if(days <= 0) return json(400,{error:'no_working_days'});
        const start_date = String(p.start_date).trim(), end_date = String(p.end_date).trim();
        const note = String(p.note == null ? '' : p.note).trim().slice(0,500);
        const { data, error } = await admin.from('holiday_requests').insert({
          user_id: me.id, type, start_date, end_date, working_days: days, note,
          status: 'pending', decided_by: null, decided_at: null, decision_note: '',
          created_at: new Date().toISOString() }).select('id').single();
        if(error) return json(500,{error:'create_failed', detail:error.message});
        const year = Number(start_date.slice(0,4));
        const balance = await holidayBalance(me.id, year);
        // A warning, never a wall. The request is already stored; whether
        // going over is acceptable is the approver's call, not the form's.
        const would_exceed = type === 'annual' && days > balance.remaining;
        return json(200,{ ok:true, id: data && data.id, status:'pending',
          working_days: days, would_exceed, balance });
      }
      case 'cancel_holiday_request': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('holiday_requests')
          .select('id,user_id,status').eq('id', p.id).single();
        if(!row) return json(404,{error:'not_found'});
        // Your own row only. A manager does not cancel on your behalf - they
        // reject, which leaves a reason behind.
        if(String(row.user_id) !== String(me.id)) return json(403,{error:'not_yours'});
        if(row.status !== 'pending') return json(409,{error:'not_pending', status:row.status});
        const { error } = await admin.from('holiday_requests')
          .update({ status:'cancelled' }).eq('id', row.id);
        if(error) return json(500,{error:'cancel_failed', detail:error.message});
        return json(200,{ ok:true, status:'cancelled' });
      }
      case 'get_holiday_inbox': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const year = holidayYear();
        // Exactly the Manager = LOCAL scope every other screen uses: null is
        // the whole company, otherwise the caller's subtree plus themselves.
        const ids = await scopeIdsFor(me);
        const { data: profs } = await admin.from('profiles')
          .select('id,first,last,nickname,role,role_id,campus,status');
        const inScope = (profs || [])
          .filter(u => u.status !== 'inactive')
          .filter(u => ids === null || ids.has(u.id));
        const { data: roleRows } = await admin.from('roles').select('id,name');
        const roleName = {}; (roleRows || []).forEach(r => { roleName[String(r.id)] = r.name; });
        const personOut = (u) => ({ id: u.id,
          name: [u.first, u.last].filter(Boolean).join(' ').trim() || (u.nickname || ''),
          role_label: roleName[String(u.role_id)] || null, campus: u.campus || null });
        const memberIds = inScope.map(u => u.id);
        const { data: rows } = memberIds.length
          ? await admin.from('holiday_requests')
              .select('id,user_id,type,start_date,end_date,working_days,note,status,decided_at,decision_note,created_at')
              .in('user_id', memberIds)
          : { data: [] };
        // Every pending request, whatever year it falls in - a January
        // request made in December still has to be approvable - plus this
        // year's decided ones as the history underneath.
        const keep = (rows || []).filter(r => r.status === 'pending' ||
          String(r.start_date || '').slice(0,4) === String(year));
        const balances = await holidayBalances(keep.map(r => r.user_id), year);
        const byId = {}; inScope.forEach(u => { byId[String(u.id)] = u; });
        const requests = holidaySort(keep).map(r => Object.assign(holidayRequestOut(r), {
          person: personOut(byId[String(r.user_id)] || { id: r.user_id }),
          balance: balances[String(r.user_id)] || null }));
        // The people themselves, for the balances screen: the same scope,
        // so a manager seeds exactly the branch they already manage.
        const peopleBal = await holidayBalances(memberIds, year);
        const people = inScope
          .map(u => Object.assign(personOut(u), { role: u.role,
            balance: peopleBal[String(u.id)] || null }))
          .sort((a,b) => String(a.name || '').localeCompare(String(b.name || '')));
        return json(200,{ year, requests, people,
          pending_count: requests.filter(r => r.status === 'pending').length,
          // "May this caller decide anything at all", for hiding buttons the
          // client would otherwise offer in vain. The seesEverything clause is
          // redundant today - senior_exec is rank 0, so the floor already
          // excludes it - and is written down because that tier reads the
          // whole company and must never act on it: if its rank were ever
          // raised to sort it above agents somewhere, this would otherwise
          // quietly start saying yes.
          can_decide: rank(me.role) >= ROLE_RANK.leader && !seesEverything(me.role) });
      }
      case 'decide_holiday_request': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const decision = String(p.decision == null ? '' : p.decision);
        if(decision !== 'approved' && decision !== 'rejected') return json(400,{error:'bad_decision'});
        const { data: row } = await admin.from('holiday_requests')
          .select('id,user_id,type,start_date,status').eq('id', p.id).single();
        if(!row) return json(404,{error:'not_found'});
        const { data: owner } = await admin.from('profiles')
          .select('id,role,first,last').eq('id', row.user_id).single();
        if(!owner) return json(404,{error:'not_found'});
        // Nobody signs off their own time off, an admin included. Checked
        // BEFORE the scope test, which a director or admin would pass on
        // themselves - rank arithmetic says you outrank you.
        if(String(owner.id) === String(me.id)) return json(403,{error:'cannot_decide_own'});
        if(!await canActOn(me, owner)) return json(403,{error:'out_of_scope'});
        // Deciding twice is a conflict, not a silent overwrite: the second
        // approver has to know somebody got there first.
        if(row.status !== 'pending') return json(409,{error:'not_pending', status:row.status});
        const note = String(p.decision_note == null ? '' : p.decision_note).trim().slice(0,500);
        // A rejection with no reason is the thing people complain about, so
        // it is simply not possible.
        if(decision === 'rejected' && !note) return json(400,{error:'reason_required'});
        const decided_at = new Date().toISOString();
        const { error } = await admin.from('holiday_requests')
          .update({ status: decision, decided_by: me.id, decided_at, decision_note: note })
          .eq('id', row.id);
        if(error) return json(500,{error:'decide_failed', detail:error.message});
        const year = Number(String(row.start_date || '').slice(0,4)) || holidayYear();
        return json(200,{ ok:true, status: decision, decided_at,
          user_id: owner.id, balance: await holidayBalance(owner.id, year) });
      }
      case 'set_holiday_allowance': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.user_id) return json(400,{error:'missing_user'});
        const { data: tgt } = await admin.from('profiles').select('id,role').eq('id', p.user_id).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await mayManageHolidays(me, tgt)) return json(403,{error:'out_of_scope'});
        const days = holidayNum(p.days);
        if(days === false || days < 0) return json(400,{error:'bad_days'});
        const year = Number(p.year) || holidayYear();
        if(!Number.isFinite(year) || year < 2000 || year > 2100) return json(400,{error:'bad_year'});
        const updated_at = new Date().toISOString();
        // unique(user_id,year), so this is a read then one of two writes -
        // the same shape every other small write in this file uses.
        const { data: existing } = await admin.from('holiday_allowances')
          .select('id').eq('user_id', tgt.id).eq('year', year).single();
        if(existing && existing.id){
          const { error } = await admin.from('holiday_allowances')
            .update({ days, updated_by: me.id, updated_at }).eq('id', existing.id);
          if(error) return json(500,{error:'save_failed', detail:error.message});
        } else {
          const { error } = await admin.from('holiday_allowances')
            .insert({ user_id: tgt.id, year, days, updated_by: me.id, updated_at });
          if(error) return json(500,{error:'save_failed', detail:error.message});
        }
        return json(200,{ ok:true, year, days,
          balance: await holidayBalance(tgt.id, year) });
      }
      case 'add_holiday_adjustment': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.user_id) return json(400,{error:'missing_user'});
        const { data: tgt } = await admin.from('profiles').select('id,role').eq('id', p.user_id).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!await mayManageHolidays(me, tgt)) return json(403,{error:'out_of_scope'});
        // Negative on purpose: this is how days are taken back as well as
        // given, which is why it cannot go through numOrNull.
        const delta = holidayNum(p.delta);
        if(delta === false) return json(400,{error:'bad_delta'});
        const year = Number(p.year) || holidayYear();
        if(!Number.isFinite(year) || year < 2000 || year > 2100) return json(400,{error:'bad_year'});
        const reason = String(p.reason == null ? '' : p.reason).trim().slice(0,300);
        const { error } = await admin.from('holiday_adjustments').insert({
          user_id: tgt.id, year, delta, reason, created_by: me.id,
          created_at: new Date().toISOString() });
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, year, delta,
          balance: await holidayBalance(tgt.id, year) });
      }
      case 'get_person_holiday': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.user_id) return json(400,{error:'missing_user'});
        const { data: tgt } = await admin.from('profiles')
          .select('id,first,last,nickname,role,role_id,campus').eq('id', p.user_id).single();
        if(!tgt) return json(404,{error:'not_found'});
        const self = String(tgt.id) === String(me.id);
        if(!self && !await mayManageHolidays(me, tgt)) return json(403,{error:'out_of_scope'});
        const year = Number(p.year) || holidayYear();
        const { data: roleRows } = await admin.from('roles').select('id,name');
        const roleName = {}; (roleRows || []).forEach(r => { roleName[String(r.id)] = r.name; });
        const { data: allowRow } = await admin.from('holiday_allowances')
          .select('days').eq('user_id', tgt.id).eq('year', year).single();
        const allowDays = allowRow ? holidayNum(allowRow.days) : false;
        const { data: adjRows } = await admin.from('holiday_adjustments')
          .select('delta,reason,created_at').eq('user_id', tgt.id).eq('year', year);
        const adjustments = (adjRows || [])
          .map(r => ({ delta: Number(r.delta || 0), reason: r.reason || '',
            created_at: r.created_at || null }))
          .sort((a,b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        const { data: reqRows } = await admin.from('holiday_requests')
          .select('id,type,start_date,end_date,working_days,note,status,decided_at,decision_note,created_at')
          .eq('user_id', tgt.id);
        const requests = (reqRows || [])
          .filter(r => String(r.start_date || '').slice(0,4) === String(year))
          .sort((a,b) => (String(b.created_at||'')+'|'+String(b.id))
            .localeCompare(String(a.created_at||'')+'|'+String(a.id)))
          .map(holidayRequestOut);
        return json(200,{ year,
          person: { id: tgt.id,
            name: [tgt.first, tgt.last].filter(Boolean).join(' ').trim() || (tgt.nickname || ''),
            role_label: roleName[String(tgt.role_id)] || null, campus: tgt.campus || null },
          balance: await holidayBalance(tgt.id, year),
          // The stored row if there is one, otherwise the default made
          // visible, so the editor opens on the number actually in force.
          allowances: { year, days: allowDays === false ? DEFAULT_ALLOWANCE : allowDays,
            is_default: allowDays === false },
          adjustments, requests });
      }
      // ── COMPETITIONS & RECOGNITION ───────────────────────────
      case 'get_competition': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const src = await competitionSource();
        const data = await loadCompetition(src);
        // A sheet that cannot be read is a state, not a failure: the page
        // says so quietly and the rest of the app carries on.
        if(data.error) return json(200,{ ok:false, error:'sheet_unavailable' });
        // Freeze anything that has closed since the last time somebody
        // looked. Opening this page is the commonest moment to be reading
        // the sheet, so it is the best chance of catching a month before
        // the tabs roll over to next year.
        await archiveCompletedMonths(src, data);
        // The current month in Dublin, which is the month the office is in.
        const nowMonth = Number(dublinYMD(new Date()).slice(5,7));
        let month = Number(p.month);
        if(!Number.isFinite(month)) month = nowMonth;
        month = Math.min(12, Math.max(1, Math.round(month)));
        const monthIdx = month - 1;
        // Highlights follow the SELECTED month, which with no month asked
        // for is the current one - so the home band gets this month and the
        // page's cards follow its picker instead of contradicting it.
        const { data: profs } = await admin.from('profiles')
          .select('id,first,last,photo,status');
        const live = (profs || []).filter(u => u.status !== 'inactive');
        const hi = competitionHighlights(data.rows, monthIdx);
        const highlights = {
          staff_of_month: {
            company: attachProfile(hi.staff_of_month.company, live),
            dublin: attachProfile(hi.staff_of_month.dublin, live),
            limerick: attachProfile(hi.staff_of_month.limerick, live) },
          sales_star: {
            company: attachProfile(hi.sales_star.company, live),
            dublin: attachProfile(hi.sales_star.dublin, live),
            limerick: attachProfile(hi.sales_star.limerick, live) },
        };
        return json(200,{ ok:true,
          months: COMP_MONTHS.map((label,i) => ({ value:i+1, label })),
          selected_month: month, current_month: nowMonth,
          ranking: competitionRanking(data.rows, monthIdx),
          highlights,
          teams: Array.from(new Set(data.rows.map(r => r.team).filter(Boolean))).sort(),
        });
      }
      case 'get_competition_source': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        // Repointing the sheet changes what the whole company sees, so it is
        // an admin job rather than an ordinary management one.
        if(rank(me.role) < ROLE_RANK.admin) return json(403,{error:'forbidden'});
        const src = await competitionSource();
        return json(200,{ source: { sheet_id: src.sheet_id,
          dublin_tab: src.dublin_tab, limerick_tab: src.limerick_tab } });
      }
      case 'set_competition_source': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(rank(me.role) < ROLE_RANK.admin) return json(403,{error:'forbidden'});
        const sheet_id = String(p.sheet_id == null ? '' : p.sheet_id).trim();
        const dublin_tab = String(p.dublin_tab == null ? '' : p.dublin_tab).trim();
        const limerick_tab = String(p.limerick_tab == null ? '' : p.limerick_tab).trim();
        if(!sheet_id) return json(400,{error:'missing_sheet_id'});
        if(!dublin_tab || !limerick_tab) return json(400,{error:'missing_tab'});
        const { error } = await admin.from('competition_source')
          .update({ sheet_id, dublin_tab, limerick_tab,
            updated_by: me.id, updated_at: new Date().toISOString() })
          .eq('id', 1);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        // The cache is keyed by sheet and tab, so a repoint would otherwise
        // keep serving the old sheet for up to five minutes.
        __compCache.clear();
        return json(200,{ ok:true, source:{ sheet_id, dublin_tab, limerick_tab } });
      }
      case 'get_hall_of_fame': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        // Archive first, so a month that closed since the last visit is in
        // the hall by the time it is drawn. A sheet that cannot be read is
        // not an error here: the hall is about the past, and the past is
        // already in the table.
        const src = await competitionSource();
        const data = await loadCompetition(src);
        await archiveCompletedMonths(src, data);
        const { data: rows } = await admin.from('hof_winners')
          .select('year,month,scope,award,agent_name,team,value,target,pct');
        // Group into one entry per month, newest first, built field by
        // field so a column added to the table later cannot leak out.
        const byMonth = new Map();
        (rows || []).forEach(r => {
          const y = Number(r.year), m = Number(r.month);
          if(!Number.isFinite(y) || !Number.isFinite(m)) return;
          const key = y + '-' + String(m).padStart(2,'0');
          if(!byMonth.has(key)) byMonth.set(key, { year:y, month:m,
            staff_of_month: { company:null, dublin:null, limerick:null },
            sales_star: { company:null, dublin:null, limerick:null } });
          const entry = byMonth.get(key);
          const group = r.award === 'sales_star' ? entry.sales_star
            : r.award === 'staff_of_month' ? entry.staff_of_month : null;
          if(!group) return;
          if(!HOF_SCOPES.includes(r.scope)) return;
          group[r.scope] = hofWinnerOut(r);
        });
        const months = Array.from(byMonth.values())
          .sort((a,b) => b.year - a.year || b.month - a.month);
        return json(200,{ ok:true, months,
          month_names: COMP_MONTHS.map((label,i) => ({ value:i+1, label })),
          sheet_unavailable: !!data.error });
      }
      // ── ASSIGNMENTS ──────────────────────────────────────────
      case 'get_my_assignments': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const { data: rows } = await admin.from('assignments')
          .select('id,user_id,type,title,description,content_id,due_date,status,submitted_at,completed_at,assigned_at')
          .eq('user_id', me.id);
        const live = (rows || []).filter(r => r.status !== 'cancelled');
        const passes = await assignmentPasses(live);
        const today = dublinYMD(new Date());
        // The trainings' own titles, so a row can say what it is rather than
        // just carrying an id the client would have to resolve.
        const tIds = Array.from(new Set(live.filter(r => r.type === 'training' && r.content_id)
          .map(r => r.content_id)));
        const titleById = {};
        if(tIds.length){
          const { data: items } = await admin.from('content_items')
            .select('id,title,has_test,active').in('id', tIds);
          (items || []).forEach(i => { titleById[String(i.id)] = i; });
        }
        const out = live.map(r => {
          const eff = assignmentEffective(r, passes, today);
          const o = assignmentOut(r, eff);
          if(r.type === 'training'){
            const item = titleById[String(r.content_id)] || null;
            o.training = { title: item ? (item.title || '') : '',
              // can_take says whether there is a test to sit at all. A
              // training without one is finished by reading it, and the
              // client must not offer a button that leads nowhere.
              can_take: !!(item && item.has_test && item.active !== false),
              passed: eff.done };
          }
          return o;
        });
        // Most urgent first: anything still open before anything finished,
        // then by due date, with undated work last.
        const rank2 = o => o.effective_done ? 1 : 0;
        out.sort((a,b) => rank2(a) - rank2(b) ||
          (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1) ||
          String(a.due_date || '').localeCompare(String(b.due_date || '')) ||
          String(b.id).localeCompare(String(a.id)));
        return json(200,{ ok:true, assignments: out, today });
      }
      case 'create_assignment': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const who = await assignmentTarget(me, p.user_id);
        if(!who.ok) return json(who.status,{error:who.error});
        const type = String(p.type == null ? '' : p.type);
        if(!ASSIGNMENT_TYPES.includes(type)) return json(400,{error:'bad_type'});
        const title = String(p.title == null ? '' : p.title).trim().slice(0,200);
        if(!title) return json(400,{error:'missing_title'});
        const description = String(p.description == null ? '' : p.description).trim().slice(0,2000);
        let due_date = null;
        if(p.due_date !== undefined && p.due_date !== null && String(p.due_date).trim() !== ''){
          const d = ymdParts(p.due_date);
          if(!d) return json(400,{error:'bad_due_date'});
          due_date = String(p.due_date).trim().slice(0,10);
        }
        let content_id = null;
        if(type === 'training'){
          // A training assignment that points at nothing, or at a material,
          // could never complete - the pass it waits for would never exist.
          const t = await trainingRow(p.content_id);
          if(!t.ok) return json(t.status,{error: t.error === 'not_found' ? 'training_not_found' : t.error});
          content_id = t.row.id;
        }
        const now = new Date().toISOString();
        const { data, error } = await admin.from('assignments').insert({
          user_id: who.tgt.id, type, title, description, content_id, due_date,
          status: 'assigned', assigned_by: me.id, assigned_at: now,
          submitted_at: null, completed_at: null, updated_at: now })
          .select('id').single();
        if(error) return json(500,{error:'create_failed', detail:error.message});
        return json(200,{ ok:true, id: data && data.id });
      }
      case 'submit_assignment': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        if(!p.id) return json(400,{error:'missing_id'});
        const { data: row } = await admin.from('assignments')
          .select('id,user_id,type,status').eq('id', p.id).single();
        if(!row) return json(404,{error:'not_found'});
        // Your own row only. A manager marking your work done for you is
        // the confirm step, not this one.
        if(String(row.user_id) !== String(me.id)) return json(403,{error:'not_yours'});
        // A training is not submitted, it is passed. Saying so plainly beats
        // a silent no-op that leaves somebody pressing a button.
        if(row.type === 'training') return json(400,{error:'training_auto'});
        if(row.status !== 'assigned') return json(409,{error:'not_assigned', status:row.status});
        const now = new Date().toISOString();
        const { error } = await admin.from('assignments')
          .update({ status:'submitted', submitted_at: now, updated_at: now }).eq('id', row.id);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, status:'submitted' });
      }
      case 'confirm_assignment': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const decision = String(p.decision == null ? '' : p.decision);
        if(decision !== 'confirm' && decision !== 'reject') return json(400,{error:'bad_decision'});
        const got = await assignmentForManager(me, p.id);
        if(!got.ok) return json(got.status,{error:got.error});
        if(got.row.type === 'training') return json(400,{error:'training_auto'});
        if(got.row.status !== 'submitted') return json(409,{error:'not_submitted', status:got.row.status});
        const now = new Date().toISOString();
        const patch = decision === 'confirm'
          ? { status:'done', completed_at: now, updated_at: now }
          // Back where it started, and the submission stamp goes with it:
          // the work was not submitted, as far as the record is concerned.
          : { status:'assigned', submitted_at: null, updated_at: now };
        if(decision === 'reject' && p.note !== undefined && p.note !== null){
          const note = String(p.note).trim().slice(0,500);
          if(note) patch.description = String(got.row.description || '').slice(0,1400) +
            '\n\nReturned by ' + [me.first, me.last].filter(Boolean).join(' ').trim() + ': ' + note;
        }
        const { error } = await admin.from('assignments').update(patch).eq('id', got.row.id);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, status: patch.status });
      }
      case 'update_assignment': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const got = await assignmentForManager(me, p.id);
        if(!got.ok) return json(got.status,{error:got.error});
        const patch = { updated_at: new Date().toISOString() };
        if(p.title !== undefined){
          const t = String(p.title == null ? '' : p.title).trim().slice(0,200);
          if(!t) return json(400,{error:'missing_title'});
          patch.title = t;
        }
        if(p.description !== undefined)
          patch.description = String(p.description == null ? '' : p.description).trim().slice(0,2000);
        if(p.due_date !== undefined){
          if(p.due_date === null || String(p.due_date).trim() === '') patch.due_date = null;
          else {
            if(!ymdParts(p.due_date)) return json(400,{error:'bad_due_date'});
            patch.due_date = String(p.due_date).trim().slice(0,10);
          }
        }
        const { error } = await admin.from('assignments').update(patch).eq('id', got.row.id);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true });
      }
      case 'cancel_assignment': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        const got = await assignmentForManager(me, p.id);
        if(!got.ok) return json(got.status,{error:got.error});
        const { error } = await admin.from('assignments')
          .update({ status:'cancelled', updated_at: new Date().toISOString() }).eq('id', got.row.id);
        if(error) return json(500,{error:'save_failed', detail:error.message});
        return json(200,{ ok:true, status:'cancelled' });
      }
      case 'get_team_assignments': {
        const me = await callerProfile(caller); if(!me) return json(403,{error:'forbidden'});
        // The same Manager = LOCAL scope every other screen uses.
        const ids = await scopeIdsFor(me);
        const { data: profs } = await admin.from('profiles')
          .select('id,first,last,nickname,role,role_id,status');
        const inScope = (profs || [])
          .filter(u => u.status !== 'inactive')
          .filter(u => ids === null || ids.has(u.id));
        const { data: roleRows } = await admin.from('roles').select('id,name');
        const roleName = {}; (roleRows || []).forEach(r => { roleName[String(r.id)] = r.name; });
        const byId = {}; inScope.forEach(u => { byId[String(u.id)] = u; });
        const memberIds = inScope.map(u => u.id);
        const { data: rows } = memberIds.length
          ? await admin.from('assignments')
              .select('id,user_id,type,title,description,content_id,due_date,status,submitted_at,completed_at,assigned_at')
              .in('user_id', memberIds)
          : { data: [] };
        const live = (rows || []).filter(r => r.status !== 'cancelled');
        const passes = await assignmentPasses(live);
        const today = dublinYMD(new Date());
        const person = u => ({ id: u.id,
          name: [u.first, u.last].filter(Boolean).join(' ').trim() || (u.nickname || ''),
          role_label: roleName[String(u.role_id)] || null, role: u.role });
        const out = live.map(r => {
          const eff = assignmentEffective(r, passes, today);
          return Object.assign(assignmentOut(r, eff),
            { person: person(byId[String(r.user_id)] || { id: r.user_id }) });
        }).sort((a,b) => String(a.person.name).localeCompare(String(b.person.name)) ||
          String(a.due_date || '').localeCompare(String(b.due_date || '')));
        // Whether this caller may actually decide anything, so the client is
        // not left offering buttons the gateway will refuse. The read-only
        // tier sees the board and acts on nobody.
        const can_decide = rank(me.role) >= ROLE_RANK.leader && !seesEverything(me.role);
        return json(200,{ ok:true, assignments: out, today, can_decide,
          to_confirm: out.filter(r => r.status === 'submitted').map(r => r.id) });
      }
      default: return json(400, { error:'unknown_action' });
    }
  } catch(e){ return json(500, { error:'server_error', detail:String(e && e.message || e) }); }
};
