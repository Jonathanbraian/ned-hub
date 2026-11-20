// ── THE EXTERNAL NEWS FETCHER ────────────────────────────────────
// A scheduled function that reads two public websites once a day and files
// what it finds, so the Updates page can carry immigration and QQI news
// beside the company's own. Nothing in the client calls it: netlify.toml
// gives it no /api/* redirect, and the only caller is the scheduler.
//
// PARSED STRUCTURE-TOLERANTLY, ON PURPOSE. Neither site is ours and neither
// publishes a contract. Class names, wrappers and markup can all change
// under us without warning, so nothing here keys on a CSS class. An item is
// accepted only when all three of these hold:
//
//   1. a URL that looks like an article on that site, not navigation
//   2. a non-empty title
//   3. a date this code can actually parse
//
// The date requirement does most of the work: a nav link, a footer link and
// a pager have no date beside them, so they fall out without needing a
// blocklist that would rot the first time a menu changes.
const { createClient } = require('@supabase/supabase-js');

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

function json(code, body){ return { statusCode: code,
  headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) }; }

// The network behind a seam, exactly as compFetch and emailFetch do it: a
// test replaces this with fixtures, and the dev container cannot reach
// either site anyway.
let __newsFetch = null;
function newsFetch(url){
  if(__newsFetch) return __newsFetch(url);
  if(typeof fetch !== 'function') return Promise.reject(new Error('no fetch in this runtime'));
  return fetch(url, { headers: { 'User-Agent': 'NED Sales Hub news reader' } });
}
exports.__setNewsFetch = (fn) => { __newsFetch = (typeof fn === 'function') ? fn : null; };

// ── TEXT ─────────────────────────────────────────────────────────
const ENTITIES = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ',
  // The two dashes are decoded to what they are, then normalised to a plain
  // hyphen by dashOut below: the house rule is that nothing a person reads
  // carries one, and a title we copy from somebody else is still read here.
  ndash:'-', mdash:'-', rsquo:"'", lsquo:"'", ldquo:'"', rdquo:'"', hellip:'...' };
function decodeEntities(s){
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const k = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
    });
}
// Whatever the source calls it, what we store is readable here, and the two
// long dashes are not. Done by code point so no literal one is ever written
// into this file.
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
function dashOut(s){
  return String(s == null ? '' : s).split(EN_DASH).join('-').split(EM_DASH).join('-');
}
function stripTags(s){ return String(s == null ? '' : s).replace(/<[^>]*>/g, ' '); }
function clean(s){
  return dashOut(decodeEntities(stripTags(s))).replace(/\s+/g, ' ').trim();
}
function cdata(s){
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(String(s == null ? '' : s));
  return m ? m[1] : s;
}
function tagText(block, tag){
  const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(block);
  return m ? clean(cdata(m[1])) : '';
}

// ── DATES ────────────────────────────────────────────────────────
// Everything is stored as ISO YYYY-MM-DD, whatever shape it arrived in.
const MONTHS = ['january','february','march','april','may','june','july',
  'august','september','october','november','december'];
function iso(y, m, d){
  // A year outside this range is a parse that went wrong rather than news,
  // and the calendar check below cannot see that: every year is a real one.
  if(!(y >= 1990 && y <= 2100)) return null;
  // One check, not three. Building the date and reading it back rejects a
  // month of 19, a day of 41 and the 31st of February alike, because none
  // of them survives the round trip. Range guards in front of it would be
  // three more lines that no input could ever reach.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if(probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return [y, String(m).padStart(2,'0'), String(d).padStart(2,'0')].join('-');
}
// "November 3, 2026" and "October 29th, 2026" alike. The ordinal suffix is
// optional and the comma is optional, because neither is load bearing.
const MONTH_NAME_DATE =
  /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/;
function isoFromMonthName(text){
  const m = MONTH_NAME_DATE.exec(String(text == null ? '' : text));
  if(!m) return null;
  const idx = MONTHS.findIndex(x => x.startsWith(String(m[1]).toLowerCase().slice(0,3))
                                 && String(m[1]).toLowerCase().length >= 3
                                 && x.indexOf(String(m[1]).toLowerCase()) === 0);
  if(idx < 0) return null;
  return iso(Number(m[3]), idx + 1, Number(m[2]));
}
// QQI writes DAY first: "08-05-2026" is the 8th of May, not the 5th of
// August. The separator is matched as "one to three non-digits" rather than
// as a named character, because the site renders it with a long dash today
// and could render it with a slash tomorrow, and because a long dash is not
// something this file is allowed to contain.
const DAY_FIRST_DATE = /\b(\d{1,2})\D{1,3}(\d{1,2})\D{1,3}(\d{4})\b/;
function isoFromDayFirst(text){
  const m = DAY_FIRST_DATE.exec(String(text == null ? '' : text));
  if(!m) return null;
  return iso(Number(m[3]), Number(m[2]), Number(m[1]));
}
// An RFC-822 date, as RSS carries it. Date.parse handles these; anything it
// cannot read is no date at all rather than an invented one.
function isoFromRfc(text){
  const t = String(text == null ? '' : text).trim();
  if(!t) return null;
  const at = Date.parse(t);
  if(!Number.isFinite(at)) return null;
  const d = new Date(at);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// ── URLS ─────────────────────────────────────────────────────────
function absolute(href, base){
  const h = String(href == null ? '' : href).trim();
  if(!h) return '';
  try { return new URL(h, base).toString(); } catch(_e){ return ''; }
}
function pathOf(u){ try { return new URL(u).pathname; } catch(_e){ return ''; } }
// An article on the immigration site is a post at the root: one path
// segment, and not one of the listing pages a post would never be. The
// listing paths are named because they are the ones that genuinely collide;
// everything else is decided by the date.
const IMM_NOT_ARTICLE = new Set(['', '/', '/news/', '/news', '/feed/', '/feed']);
function immIsArticle(u){
  const p = pathOf(u);
  if(!p || IMM_NOT_ARTICLE.has(p)) return false;
  if(p.indexOf('/category/') === 0) return false;
  if(p.indexOf('/tag/') === 0) return false;
  return /^\/[^/]+\/?$/.test(p);
}
// A QQI article lives under /news/<slug>. The bare /news and /news/ index
// are not articles, and neither is a pager link carrying a query.
function qqiIsArticle(u){
  const p = pathOf(u);
  const m = /^\/news\/([^/?#]+)\/?$/.exec(p);
  return !!(m && m[1]);
}

// ── PARSERS ──────────────────────────────────────────────────────
// Each returns a list of { url, title, published_at }, in page order, with
// the first appearance of a URL winning.
function dedupe(items){
  const seen = new Set(); const out = [];
  items.forEach(it => {
    if(!it || !it.url || seen.has(it.url)) return;
    seen.add(it.url); out.push(it);
  });
  return out;
}
// RSS, tried first for immigration because a feed is a contract and a page
// is not. A channel that parses to nothing is treated as no feed at all, so
// the scrape below gets its turn.
function parseRss(xml, opts){
  const o = opts || {};
  const blocks = String(xml == null ? '' : xml).match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const out = blocks.map(b => {
    const title = tagText(b, 'title');
    const link = absolute(tagText(b, 'link'), o.base || '');
    const published_at = isoFromRfc(tagText(b, 'pubDate'));
    if(!title || !link || !published_at) return null;
    if(o.isArticle && !o.isArticle(link)) return null;
    return { url: link, title, published_at };
  }).filter(Boolean);
  return dedupe(out);
}
// The immigration listing. Each item is a heading that holds the link, and
// the date sits in the block after it, so the window searched for a date
// runs from the end of one heading to the start of the next.
function parseImmigrationHtml(html, base){
  const src = String(html == null ? '' : html);
  const heads = [];
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let m;
  while((m = re.exec(src)) !== null) heads.push({ inner: m[1], end: re.lastIndex });
  const out = heads.map((h, i) => {
    const a = /<a[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(h.inner);
    if(!a) return null;
    const url = absolute(a[1], base);
    if(!url || !immIsArticle(url)) return null;
    const title = clean(a[2]);
    if(!title) return null;
    const next = (i + 1 < heads.length)
      ? src.indexOf('<h2', h.end)
      : -1;
    const window = src.slice(h.end, next > h.end ? next : h.end + 1200);
    const published_at = isoFromMonthName(clean(window));
    if(!published_at) return null;
    return { url, title, published_at };
  }).filter(Boolean);
  return dedupe(out);
}
// A date belongs to the item it is rendered WITH, so the text searched for
// one is the anchor's own enclosing block and nothing outside it. The block
// is found by structure - the nearest enclosing container tag - rather than
// by a class name, and is clamped again by the neighbouring article links so
// a window can never reach into the item above or the item below. Without
// that clamp a row whose own date is missing silently adopts its
// neighbour's, which is worse than having no date at all.
const BLOCK_OPEN  = /<(?:div|li|article|section|tr)[\s>]/gi;
const BLOCK_CLOSE = /<\/(?:div|li|article|section|tr)>/gi;
function lastIndexOfTag(src, re, before){
  let at = -1, m; re.lastIndex = 0;
  while((m = re.exec(src)) !== null){
    if(m.index >= before) break;
    at = m.index;
  }
  return at;
}
function firstIndexOfTag(src, re, from){
  re.lastIndex = from;
  const m = re.exec(src);
  return m ? m.index + m[0].length : -1;
}
// The QQI listing. Date before the title or after it both work, because the
// window is the whole enclosing block either way.
function parseQqiHtml(html, base){
  const src = String(html == null ? '' : html);
  const re = /<a[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const hits = [];
  let m;
  while((m = re.exec(src)) !== null){
    const url = absolute(m[1], base);
    if(!url || !qqiIsArticle(url)) continue;
    const title = clean(m[2]);
    if(!title) continue;
    hits.push({ url, title, start: m.index, end: re.lastIndex });
  }
  const out = hits.map((h, i) => {
    const prevEnd = i > 0 ? hits[i-1].end : 0;
    const nextStart = (i + 1 < hits.length) ? hits[i+1].start : src.length;
    const blockStart = lastIndexOfTag(src, BLOCK_OPEN, h.start);
    const blockEnd = firstIndexOfTag(src, BLOCK_CLOSE, h.end);
    const lo = Math.max(prevEnd, blockStart >= 0 ? blockStart : 0);
    const hi = Math.min(nextStart, blockEnd >= 0 ? blockEnd : src.length);
    if(hi <= lo) return null;
    const published_at = isoFromDayFirst(clean(src.slice(lo, hi)));
    if(!published_at) return null;
    return { url: h.url, title: h.title, published_at };
  }).filter(Boolean);
  return dedupe(out);
}

// ── THE SOURCES ──────────────────────────────────────────────────
// Immigration is RSS first and the listing second: a feed is a contract.
// Both feed paths are tried because WordPress serves one per category and
// one for the site, and this site advertises neither in its head.
const SOURCES = {
  immigration: {
    label: 'Immigration',
    base: 'https://www.irishimmigration.ie/',
    rss: ['https://www.irishimmigration.ie/category/updates-and-announcements/feed/',
          'https://www.irishimmigration.ie/feed/'],
    page: 'https://www.irishimmigration.ie/news/',
    isArticle: immIsArticle,
    scrape: parseImmigrationHtml,
  },
  qqi: {
    label: 'QQI',
    base: 'https://www.qqi.ie/',
    rss: [],
    page: 'https://www.qqi.ie/news',
    isArticle: qqiIsArticle,
    scrape: parseQqiHtml,
  },
};

async function readText(url){
  const res = await newsFetch(url);
  if(!res || res.ok === false) return { ok:false, status: res ? res.status : 0 };
  const text = await res.text();
  return { ok:true, text: String(text == null ? '' : text) };
}
// What one source has to say today. Never throws: a source that is down is a
// state this function records, not a failure that takes the other one with
// it.
async function collect(key){
  const s = SOURCES[key];
  if(!s) return { ok:false, items:[], error:'unknown_source' };
  for(const feed of s.rss){
    try {
      const r = await readText(feed);
      if(!r.ok) continue;
      const items = parseRss(r.text, { base: s.base, isArticle: s.isArticle });
      if(items.length) return { ok:true, items, via:'rss', from:feed };
    } catch(_e){ /* and on to the next one */ }
  }
  try {
    const r = await readText(s.page);
    if(!r.ok) return { ok:false, items:[], error:'http_' + r.status };
    const items = s.scrape(r.text, s.base);
    return { ok:true, items, via:'scrape', from:s.page };
  } catch(e){
    return { ok:false, items:[], error: (e && e.message) || 'fetch_failed' };
  }
}

// ── FILING WHAT WAS FOUND ────────────────────────────────────────
// insert, ignoring a URL already on file. NOT an update: an item somebody
// hid has hidden=true on its row, and re-writing the row would bring it
// back. Nothing about these items changes after publication anyway.
async function store(key, items){
  if(!items.length) return { inserted:0 };
  // hidden is written out rather than left to the column default. The
  // default would do the same thing, but a row this function creates is a
  // row it should be able to describe completely, and the visible/hidden
  // state is the one field here that anybody ever changes.
  const rows = items.map(it => ({
    url: it.url, source: key, title: it.title,
    published_at: it.published_at, excerpt: it.excerpt || null,
    hidden: false,
  }));
  const { data, error } = await admin.from('external_news')
    .upsert(rows, { onConflict:'url', ignoreDuplicates:true }).select('url');
  if(error) return { inserted:0, error: error.message };
  return { inserted: (data || []).length };
}
async function writeStatus(key, patch){
  const row = Object.assign({ source: key }, patch);
  const { error } = await admin.from('news_fetch_status')
    .upsert(row, { onConflict:'source' });
  return error ? error.message : null;
}
// One source, start to finish, and it cannot throw.
async function runSource(key){
  let got;
  try {
    got = await collect(key);
  } catch(e){
    got = { ok:false, items:[], error: (e && e.message) || 'collect_failed' };
  }
  if(!got.ok){
    await writeStatus(key, { last_error: String(got.error || 'failed').slice(0,300) });
    return { source:key, ok:false, error: got.error, inserted:0, found:0 };
  }
  const put = await store(key, got.items);
  if(put.error){
    await writeStatus(key, { last_error: String(put.error).slice(0,300) });
    return { source:key, ok:false, error: put.error, inserted:0, found: got.items.length };
  }
  await writeStatus(key, { last_ok_at: new Date().toISOString(),
    last_count: got.items.length, last_error: null });
  return { source:key, ok:true, via: got.via, found: got.items.length, inserted: put.inserted };
}

exports.handler = async () => {
  const out = [];
  // One after the other, each inside its own guard: whichever one fails,
  // the other still files what it found.
  for(const key of Object.keys(SOURCES)) out.push(await runSource(key));
  return json(200, { ok:true, sources: out });
};

exports.__news = { parseRss, parseImmigrationHtml, parseQqiHtml,
  isoFromMonthName, isoFromDayFirst, isoFromRfc, iso, clean, decodeEntities,
  dashOut, immIsArticle, qqiIsArticle, collect, runSource, SOURCES };
