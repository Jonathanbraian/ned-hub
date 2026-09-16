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
          .select('id,first,last,nickname,email,role,campus,team,phone,instagram,nationality,language,job_title,status,reports_to,photo,bio,monthly_target,role_id,team_target')
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
        const { data: created, error: cErr } = await admin.auth.admin.createUser({
          email, password, email_confirm:true
        });
        if(cErr) return json(400,{error:'auth_create_failed', detail:cErr.message});
        const newId = created.user.id;
        const campus = ['dublin','limerick','both'].includes((b.campus||'').toLowerCase())
          ? (b.campus).toLowerCase() : 'dublin';
        const { error: pErr } = await admin.from('profiles').insert({
          id:newId, first, last, email, role, campus, role_id: cargo.id,
          team: b.team || 'All', phone: b.phone || '',
          reports_to: b.reports_to || null,
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
          .select('id,role,role_id,monthly_target,team_target').in('id',ids);
        const { data: roleRows } = await admin.from('roles')
          .select('id,base_level,individual_target,team_target');
        const byRole = {}; (roleRows||[]).forEach(r=>{ byRole[r.id]=r; });
        // One resolver, server-side:
        //   individual = monthly_target ?? cargo.individual_target ?? ROLE_TARGETS[base] ?? 0
        //   team       = team_target    ?? cargo.team_target       ?? (absent)
        const eff = {}, effTeam = {};
        (profs||[]).forEach(u=>{
          const cargo = (u.role_id!=null) ? byRole[u.role_id] : null;
          eff[u.id] = (u.monthly_target!=null) ? Number(u.monthly_target)
            : (cargo && cargo.individual_target!=null) ? Number(cargo.individual_target)
            : (ROLE_TARGETS[u.role]||0);
          const tt = (u.team_target!=null) ? Number(u.team_target)
            : (cargo && cargo.team_target!=null) ? Number(cargo.team_target)
            : null;
          if(tt!=null) effTeam[u.id] = tt;
        });
        return json(200,{ year, results: rows||[], effective_targets: eff, effective_team_targets: effTeam });
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
        if(!me || !canUpdatePerf(me.role)) return json(403,{error:'forbidden'});
        const uid = p.user_id;
        if(!uid) return json(400,{error:'missing_id'});
        const team_target = numOrNull(p.team_target);
        if(team_target===false) return json(400,{error:'bad_number'});
        const { data: tgt } = await admin.from('profiles').select('id,role,reports_to').eq('id',uid).single();
        if(!tgt) return json(404,{error:'not_found'});
        if(!inScope(me,tgt)) return json(403,{error:'out_of_scope'});
        const { error } = await admin.from('profiles').update({ team_target }).eq('id',uid);
        if(error) return json(500,{error:'save_failed'});
        return json(200,{ ok:true });
      }
      default: return json(400, { error:'unknown_action' });
    }
  } catch(e){ return json(500, { error:'server_error', detail:String(e && e.message || e) }); }
};
