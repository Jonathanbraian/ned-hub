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
const CONTENT_TYPES = ['training','course','material','tool'];
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
              .select('id,period,rating,notes,tags,created_by,created_at')
              .eq('user_id',uid).order('created_at',{ascending:false})
          : { data: [] };
        const authorIds = [...new Set((aps||[]).map(a=>a.created_by).filter(Boolean))];
        const authors = {};
        if(authorIds.length){
          const { data: who } = await admin.from('profiles').select('id,first,last').in('id',authorIds);
          (who||[]).forEach(w=>{ authors[w.id] = (w.first||'')+' '+(w.last||''); });
        }
        const appraisals = (aps||[]).map(a=>Object.assign({}, a, { created_by_name: authors[a.created_by] || null }));

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
        const rating = Number(p.rating);
        if(!period) return json(400,{error:'missing_period'});
        if(!(rating >= 1 && rating <= 5)) return json(400,{error:'bad_rating'});
        const { data, error } = await admin.from('appraisals').insert({
          user_id: uid, period, rating, notes: (p.notes||'').toString(),
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
        const rating = Number(p.rating);
        if(!period) return json(400,{error:'missing_period'});
        if(!(rating >= 1 && rating <= 5)) return json(400,{error:'bad_rating'});
        const { error } = await admin.from('appraisals').update({
          period, rating, notes: (p.notes||'').toString(),
          tags: Array.isArray(p.tags) ? p.tags : []
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
          .select('id,type,title,description,category,cover_url,file_path,file_name,file_type,has_test,pass_threshold,sort_order,created_at')
          .eq('active', true)
          .order('sort_order',{ascending:true}).order('created_at',{ascending:true});
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
      default: return json(400, { error:'unknown_action' });
    }
  } catch(e){ return json(500, { error:'server_error', detail:String(e && e.message || e) }); }
};
