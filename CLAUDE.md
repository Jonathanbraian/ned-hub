# NED Sales Hub

A single-page PWA (`index.html`) backed by one Netlify Function gateway
(`netlify/functions/db.js`). There is no build step: the page is served as
it is written.

## House style

**Plain hyphens only in anything a person reads.** No em dash, no en dash,
no `&mdash;`/`&ndash;` entity and no backslash-u escape for either, in markup,
in string literals or in attributes a screen reader speaks. Code comments
may use what they like - nobody reads those but us.

## Data access

Every read and write goes through `/api/db` (the gateway), which holds the
service-role key. RLS is on for every table with no client policies, so the
browser never talks to Postgres directly. Each action re-establishes who the
caller is with `callerProfile` and gates itself; nothing is trusted from the
request body.

Responses are built **field by field**, never by passing a row through. That
is what keeps `file_path`, `correct_index` and anything else private from
reaching a client that only needed a title.

## Scope: Manager = LOCAL

`canActOn(me, tgt)` is the one "may I act on this person" predicate, and
`scopeIdsFor(me)` the one "whose rows may I see" answer. A manager,
supervisor or leader reaches their own transitive subtree; a director or
admin reaches by rank; `senior_exec` reads everything and acts on nobody.

Gate authority on `rank(me.role) >= ROLE_RANK.director`, never on
`seesWholeCompany`, which includes the rank-0 read-only tier.

## Content audience

Every `content_items` row carries `audience`: `everyone`, `agents` or
`leadership`. Two tiers decide who is shown what, and they are **not** the
rank table:

- **agents**: `agent`, `specialist`, `executive`
- **leadership**: `senior_exec`, `leader`, `supervisor`, `manager`,
  `director`, `admin`

`senior_exec` ranks 0 because it acts on nobody, and is leadership here
because the question is what it is SHOWN. Answering it with rank would
hand a senior executive the agents' shelf.

An item is listed to a caller when its audience is `everyone`, when it
matches `audienceTierFor(me)`, or when `isMgr(me.role)` - managers see
everything because they are the ones who manage it. The filter runs on
the way out of every path that lists content, so an item aimed elsewhere
is never listed at all rather than listed and refused. Anything
unrecognised, including a row written before the column existed, reads as
`everyone`.

## Schema

Tables are created by hand in Supabase before the work that uses them.
**Do not emit or run SQL** - reference the columns and assume they exist.
