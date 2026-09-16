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
function isMgr(role){ return role === 'manager' || role === 'director'; }

const ROLE_TARGETS = { agent:14000, specialist:17000, executive:20000, leader:22000,
  supervisor:22000, manager:0, director:0 };
function canUpdatePerf(role){ return role==='supervisor'||role==='manager'||role==='director'; }
function inScope(me, tgt){
  if(me.role==='director') return true;
  if(me.role==='manager') return tgt.role!=='director';
  if(me.role==='supervisor') return tgt.reports_to===me.id || tgt.id===me.id;
  return false;
}
const ROLE_LEVELS = ['agent','specialist','executive','leader','supervisor','manager','director'];
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
// Teams a caller can see figures for: leadership sees all, a supervisor or
// leader sees the teams they lead plus the teams their people sit on.
function accessibleTeamIds(me, allTeams, allProfs){
  if(me.role==='director' || me.role==='manager') return allTeams.map(t=>t.id);
  if(me.role==='supervisor' || me.role==='leader'){
    const mine = new Set();
    allTeams.forEach(t => { if(t.leader_id === me.id) mine.add(t.id); });
    allProfs.forEach(u => {
      if(u.team_id!=null && (u.reports_to === me.id || u.id === me.id)) mine.add(u.team_id);
    });
    return [...mine];
  }
  return [];
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
  if(me.role === 'director') return true;
  if(me.role === 'manager') return tgt.role !== 'director';
  if(me.role === 'supervisor' || me.role === 'leader') return (await subtreeIds(me)).has(tgt.id);
  return false;
}
// Viewing is the same set: editors, plus nothing extra. Leadership sees broadly
// because the two clauses above already cover it.
async function canViewProfileOf(me, tgt){
  return canEditProfileOf(me, tgt);
}
// All the profile gates in one place, computed from a single subtree walk.
//   view/edit : self, or up the chain
//   certs     : chain only - a non-director cannot manage their own
//   appraisals: chain only, never about yourself, not even for a director
//   documents : chain only - a non-director cannot see their own
async function gatesFor(me, tgt){
  const self = me.id === tgt.id;
  const needSub = (me.role === 'supervisor' || me.role === 'leader');
  const sub = needSub ? await subtreeIds(me) : null;
  let chain;
  if(me.role === 'director') chain = true;
  else if(me.role === 'manager') chain = tgt.role !== 'director';
  else if(needSub) chain = sub.has(tgt.id);
  else chain = false;
  const chefia = chain && !(self && me.role !== 'director');
  return {
    canView: self || chain,
    canEdit: self || chain,
    certView: self || chain,
    certManage: chefia,
    appraisal: !self && chain,
    doc: chefia
  };
}
const DOC_CATEGORIES = ['Contract','Certificate','Appraisal','Training','ID','Other'];
function safeFileName(n){
  return String(n||'file').replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,80) || 'file';
}
const PROFILE_EDITABLE = ['first','last','nickname','job_title','phone','instagram','nationality','language','bio'];
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
  if(me.role==='director') return all.map(u=>u.id);
  if(me.role==='manager') return all.filter(u=>u.role!=='director').map(u=>u.id);
  if(me.role==='supervisor'||me.role==='leader'){
    const ids = all.filter(u=>u.reports_to===me.id).map(u=>u.id); ids.push(me.id); return ids;
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
          .select('id,first,last,nickname,email,role,campus,team,phone,instagram,nationality,language,job_title,status,reports_to,photo,bio,monthly_target,role_id,team_id')
          .order('first',{ascending:true});
        if(error) return json(500,{error:'directory_failed'});
        return json(200,{ directory:data });
      }
      case 'list_users': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        let q = admin.from('profiles').select('*').order('first',{ascending:true});
        if(me.role === 'manager') q = q.neq('role','director');
        const { data, error } = await q;
        if(error) return json(500,{error:'list_failed'});
        return json(200,{ users:data });
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
        if(me.role === 'manager' && role === 'director') return json(403,{error:'forbidden_role'});
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
        const { data: created, error: cErr } = await admin.auth.admin.createUser({
          email, password, email_confirm:true
        });
        if(cErr) return json(400,{error:'auth_create_failed', detail:cErr.message});
        const newId = created.user.id;
        const campus = ['dublin','limerick','both'].includes((b.campus||'').toLowerCase())
          ? (b.campus).toLowerCase() : 'dublin';
        const { error: pErr } = await admin.from('profiles').insert({
          id:newId, first, last, email, role, campus, role_id: cargo.id,
          team: b.team || 'All', team_id: teamId, phone: b.phone || '',
          reports_to: reportsTo,
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
        const { data: tgt } = await admin.from('profiles').select('role').eq('id',targetId).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(me.role === 'manager' && tgt.role === 'director') return json(403,{error:'forbidden'});
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
        const { data: tgt } = await admin.from('profiles').select('role').eq('id',targetId).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(me.role === 'manager' && tgt.role === 'director') return json(403,{error:'forbidden'});
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
        const teamIds = accessibleTeamIds(me, allTeams||[], allProfs||[]);
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
        if(!inScope(me,tgt)) return json(403,{error:'out_of_scope'});
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
        if(!inScope(me,tgt)) return json(403,{error:'out_of_scope'});
        const { error } = await admin.from('profiles').update({monthly_target:val}).eq('id',uid);
        if(error) return json(500,{error:'save_failed'});
        return json(200,{ ok:true });
      }
      case 'get_roles': {
        const { data, error } = await admin.from('roles')
          .select('id,name,base_level,individual_target,team_target,active').order('name',{ascending:true});
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
        // A manager may not mint a director tier, mirroring create_user.
        if(me.role==='manager' && base_level==='director') return json(403,{error:'forbidden_role'});
        const individual_target = numOrNull(p.individual_target);
        const team_target = numOrNull(p.team_target);
        if(individual_target===false || team_target===false) return json(400,{error:'bad_number'});
        const { data, error } = await admin.from('roles')
          .insert({ name, base_level, individual_target, team_target, active:true })
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
        const team_target = numOrNull(p.team_target);
        if(individual_target===false || team_target===false) return json(400,{error:'bad_number'});
        const { data: existing } = await admin.from('roles').select('id,base_level').eq('id',id).single();
        if(!existing) return json(404,{error:'not_found'});
        // A manager may neither create a director tier nor edit one.
        if(me.role==='manager' && (base_level==='director' || existing.base_level==='director'))
          return json(403,{error:'forbidden_role'});
        const { error } = await admin.from('roles')
          .update({ name, base_level, individual_target, team_target, active: p.active !== false })
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
        if(me.role==='manager' && existing.base_level==='director') return json(403,{error:'forbidden_role'});
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
        // Managers and directors, or the team's own leader.
        if(!isMgr(me.role) && team.leader_id !== me.id) return json(403,{error:'out_of_scope'});
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
      case 'set_member_team': {
        const me = await callerProfile(caller);
        if(!me || !isMgr(me.role)) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        const { data: tgt } = await admin.from('profiles').select('id,role').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(me.role === 'manager' && tgt.role === 'director') return json(403,{error:'forbidden'});
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
        // Joining a team with a leader also lines the hierarchy up behind them.
        const patch = { team_id: team.id };
        if(team.leader_id && team.leader_id !== uid) patch.reports_to = team.leader_id;
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

        return json(200,{ profile: tgt, certs, appraisals, documents,
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
      default: return json(400, { error:'unknown_action' });
    }
  } catch(e){ return json(500, { error:'server_error', detail:String(e && e.message || e) }); }
};
