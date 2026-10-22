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

## Supabase setup (schema and storage)

This is the inventory a fresh Supabase project has to match, drawn from what
the gateway actually reads and writes. It is a reference, not DDL - the rule
above still holds: **do not emit or run SQL**. Its purpose is that a new
environment can be provisioned from it, and that drift is caught by reading
rather than by a save failing. Each table needs its own primary key; `id`
appears below wherever the gateway references one.

### Storage buckets

| bucket | access | why |
| --- | --- | --- |
| `content-files` | **private** | every read is a 60s signed URL; lessons get an hour |
| `content-covers` | **public** | a cover's public URL is stored on the row and rendered straight into an `img` |
| `documents` | private | HR documents, read through a 60s signed URL |
| `avatars` | public | the photo on a profile card |

**No size limit and no MIME restriction on any of them.** Size is enforced in
the client (`CONTENT_MAX_MB`) and the gateway sanitises the filename; a bucket
restriction would reject valid uploads with a message nobody can act on. The
two content buckets are written through `createSignedUploadUrl`, so the bytes
go browser to Storage and never through the function body.

### The two settings that bite

- **`content_items.type` must have NO CHECK constraint.** The valid types are
  `CONTENT_TYPES` in `db.js` and nothing else: `training`, `course`,
  `material`, `tool`, `update`, `procedure`, `handbook`. A CHECK here is how a
  type added in code turns into "Could not save this item" at runtime.
- **`content_items.pass_threshold` is nullable**, and so is
  `test_num_questions`: switching a test off writes `null` to both. A NOT NULL
  on either breaks saving a training that has no test.

### Tables

- **`profiles`** - `id` (the auth user's uuid), `first`, `last`, `nickname`,
  `email`, `role` (the role enum), `role_id` (the cargo), `campus`, `team_id`,
  `reports_to`, `phone`, `instagram`, `linkedin`, `nationality`, `language`,
  `languages` (`text[]`), `bio`, `job_title`, `photo`, `birth_day`,
  `birth_month` (integers), `start_date`, `status`, `monthly_target`,
  `results_name` (the name this person goes by on the forecast sheet, which is
  how a profile is matched to it), `theme`, `last_login`,
  `must_change_password`.
- **`content_items`** - `id`, `type`, `title`, `description`, `category`,
  `cover_url`, `file_path`, `file_name`, `file_type`, `link_url`, `pinned`,
  `sort_order`, `active`, `has_test`, `pass_threshold`, `test_num_questions`,
  `audience` (`everyone` / `agents` / `leadership`), `created_at`.
- **`training_questions`** - `id`, `content_id`, `question`, `options` (an
  array of strings), `correct_index`, `sort_order`. `correct_index` never
  leaves the server except to an `isMgr` caller.
- **`training_pieces`** - `id`, `training_id`, `sort_order`, `title`,
  `media_type`, `file_path`, `file_name`, `file_type`, `caption`,
  `created_at`.
- **`training_piece_progress`** - `user_id`, `piece_id`, `training_id`,
  `completed_at`.
- **`training_attempts`** - `id`, `user_id`, `content_id`, `score`, `passed`,
  `answers` (jsonb), `created_at`.
- **`training_completions`** - `id`, `user_id`, `content_id`, `cert_number`,
  `score`, `completed_at`.
- **`sales_results`** - `user_id`, `year`, `month`, `target`, `actual`,
  `notes`, `updated_by`, `updated_at`. `target` is nullable - blank means
  "fall back to the ladder", and a 0 that masked the default was the bug.
  `actual` is still written but **read by nothing**: the figure comes from the
  forecast sheet plus `result_extras`.
- **`result_extras`** - `id`, `user_id`, `year`, `month`, `kind`, `amount`,
  `note`, `created_by`, `created_at`.
- **`teams`** - `id`, `name`, `leader_id`, `campus`, `team_target`, `active`.
- **`roles`** (the cargos) - `id`, `name`, `base_level`, `individual_target`,
  `active`.
- **`locations`** - `id`, `name`, `campus`, `active`.
- **`lead_sources`** - `id`, `name`, `active`, `sort_order`.
- **`weekly_cycles`** - `id`, `week_start`, `status`.
- **`weekly_entries`** - `id`, `cycle_id`, `user_id`, `sales_dub_expected`,
  `sales_dub_received`, `sales_lim_expected`, `sales_lim_received`,
  `submitted`, `submitted_at`, `last_edited_by`, `updated_at`.
- **`weekly_lead_rows`** - `id`, `entry_id`, `source_id`, `received`, `sold`.
- **`assignments`** - `id`, `user_id`, `type`, `title`, `description`,
  `content_id`, `due_date`, `status`, `assigned_by`, `assigned_at`,
  `submitted_at`, `completed_at`, `updated_at`.
- **`appraisals`** - `id`, `user_id`, `template`, `period`, `rating`,
  `responses` (jsonb, and an object - an array or a string stores happily and
  renders as nothing), `tags`, `notes`, `created_by`, `created_at`.
- **`meetings`** - `id`, `type`, `meeting_date`, `meeting_time`, `duration`,
  `location`, `location_id`, `is_online`, `jitsi_room`, `notes`, `minutes`,
  `minutes_private`, `created_by`, `created_at`.
- **`meeting_attendees`** - `meeting_id`, `user_id`.
- **`threads`** - `id`, `kind`, `team_id`, `user_a`, `user_b`.
- **`messages`** - `id`, `thread_id`, `sender_id`, `body`, `created_at`.
- **`thread_reads`** - `thread_id`, `user_id`, `last_read_at`.
- **`holiday_requests`** - `id`, `user_id`, `type`, `start_date`, `end_date`,
  `working_days`, `note`, `status`, `decided_by`, `decided_at`,
  `decision_note`, `created_at`.
- **`holiday_allowances`** - `id`, `user_id`, `year`, `days`, `updated_by`,
  `updated_at`.
- **`holiday_adjustments`** - `user_id`, `year`, `delta`, `reason`,
  `created_by`, `created_at`.
- **`user_documents`** - `id`, `user_id`, `name`, `category`, `doc_date`,
  `notes`, `file_url` (the path inside the `documents` bucket), `created_at`.
- **`cert_catalog`** - `id`, `name`. **`user_certs`** - `user_id`, `cert_id`,
  `date_earned`.
- **`hof_winners`** - `year`, `month`, `scope`, `award`, `agent_name`, `team`,
  `value`, `target`, `pct`, `captured_at`.
- **`competition_source`** - `id`, `sheet_id`, `dublin_tab`, `limerick_tab`,
  `updated_by`, `updated_at`.

### Unique constraints the gateway relies on

These are not decoration: the code either upserts onto them or reads `23505`
as its answer, so a missing one turns a duplicate into a second row.

`sales_results (user_id, year, month)` · `thread_reads (thread_id, user_id)` ·
`user_certs (user_id, cert_id)` · `training_piece_progress (user_id,
piece_id)` · `training_completions (user_id, content_id)` **and**
`training_completions (cert_number)` · `holiday_allowances (user_id, year)` ·
`threads (user_a, user_b)` · `hof_winners (year, month, scope, award)` ·
`name` on `roles`, `lead_sources`, `teams`, `locations` and `cert_catalog` ·
`email` on `profiles`.

### Seed rows

**`competition_source` must contain a row with `id = 1`.** The gateway reads
and writes that row by id, so with the table empty the rankings source saves
as a silent no-op and the sheet never changes.
