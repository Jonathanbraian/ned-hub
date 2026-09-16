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
      default: return json(400, { error:'unknown_action' });
    }
  } catch(e){ return json(500, { error:'server_error', detail:String(e && e.message || e) }); }
};
