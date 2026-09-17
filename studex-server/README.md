# Studex — back end

The API behind the Studex study app. Every entity here comes from the ten
screens in the `Studex App` design: the folder/file library, the block document
editor, the infinite canvas, PDF annotation, spaced-repetition flashcards, the
calendar and focus timer, statistics, and the account/device settings split.

TypeScript · Fastify 5 · SQLite (WAL) · zod · argon2id

It also serves the desktop interface when `WEB_DIR` is set, which is how the
Mac app in [`../studex-mac`](../studex-mac) runs: one process, one origin, no
CORS. Unset, it is a pure JSON API and nothing below changes.

## Running it

All commands run from the `studex-server` directory.

```bash
cd studex-server && npm install
```

```bash
cp .env.example .env && npm run migrate && npm run seed
```

```bash
npm run dev
```

`npm run seed` creates the demo account from the design — Aisha K., eleven days
out from Chem Paper 2, with an 18-day streak:

```
aisha@studex.test / revision-season-2026
```

Other scripts: `npm test`, `npm run typecheck`, `npm run build`, `npm start`.

### Configuration

All settings come from the environment; see `.env.example`. The `dev`, `start`,
`migrate` and `seed` scripts load `.env` automatically via Node's
`--env-file-if-exists`. `npm test` deliberately does not — the tests set their
own environment in `test/setup.ts`, so a local `.env` cannot make a test run
non-hermetic. In production
`SESSION_SECRET` is required and must be at least 32 bytes — the server refuses
to boot without it rather than falling back to a generated one.

`CORS_ORIGINS` is an exact-match allowlist of origins permitted to call the API
with credentials. It is also the allowlist used for `Origin` enforcement on
state-changing requests, so setting it correctly matters for CSRF as well. When
`WEB_DIR` is set the server's own origin is added to that list automatically,
since the interface it is serving has to be able to call it.

`COOKIE_SECURE` decides whether the session cookie is marked `Secure`. It
follows `NODE_ENV` by default, and may only be turned off in production when
`HOST` is a loopback address — the desktop case, where the server talks to
itself over http on a port that never reaches a network and a `Secure` cookie
would simply never be stored. The same condition drops `Strict-Transport-
Security` and `upgrade-insecure-requests`, which are claims about a transport
that process does not have.

## Data model

```
users ── sessions
      ├─ subjects ──────────┐
      ├─ folders (tree) ────┤ folders belong to a subject; colour is inherited
      │    └─ files ────────┘ down the tree unless a file overrides it
      │        ├─ documents   (block list, optimistic revision)
      │        ├─ canvases    (objects + viewport, optimistic revision)
      │        ├─ pdf_files ── annotations (highlight / ink / comment)
      │        └─ decks ────── cards ── review_logs
      ├─ events            (exam / deadline / study_block / class)
      ├─ study_sessions    (focus timer)
      ├─ test_sessions
      ├─ user_settings     (theme, accent — follow the account)
      ├─ device_settings   (shell layout, canvas chrome — per device)
      ├─ shares
      └─ search_index      (FTS5 over titles, documents, annotations, cards)
```

Ids are UUIDs, timestamps are epoch milliseconds, and every user-owned row
carries `user_id` and cascades when the account is deleted.

## API

All routes are under `/api` and require authentication unless marked public.

**Auth** — `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`,
`GET /auth/me`, `PATCH /auth/me/plan`, `GET /auth/sessions`,
`DELETE /auth/sessions`, `POST /auth/change-password`, `GET /auth/status`
*(public: whether this instance has been set up at all)*

**Library** — `GET|POST /subjects` · `GET|POST /folders`,
`PATCH|DELETE /folders/:id` · `GET|POST /files`, `GET|PATCH|DELETE /files/:id`,
`POST /files/:id/restore`, `DELETE /files/:id/purge` · `GET /storage`

**Documents** — `GET|PUT /documents/:id`, `GET /documents/:id/outline`,
`POST /documents/:id/deck` *(idempotent: the document's own card deck)*

**Import** — `POST /import` — a RemNote export (or any indented outline)
becomes a document, with the cards it describes in that document's deck. See
`domain/import.ts`; the parser is pure and tested on its own in
`test/import.test.ts`.

**Canvas** — `GET|PUT /canvases/:id`

**PDF** — `POST /pdfs` (multipart) · `GET|PATCH /pdfs/:id` ·
`GET /pdfs/:id/content` · `GET|POST /pdfs/:id/annotations`,
`PATCH|DELETE /pdfs/:id/annotations/:annotationId` ·
`POST /pdfs/:id/cards-from-highlights` · `GET /pdfs/:id/export`

**Flashcards** — `GET /decks/:id/cards`, `GET /decks/:id/stats` ·
`POST /cards`, `PATCH|DELETE /cards/:id` · `GET /study/queue`,
`GET /study/today` ·
`POST /cards/:id/review` · `POST /tests`, `GET /tests/:id`,
`POST /tests/:id/answers`, `POST /tests/:id/end`

**Calendar & timer** — `GET|POST /events`, `PATCH|DELETE /events/:id`,
`GET /events/upcoming`, `GET /plan/today` · `GET /study-sessions/active`,
`POST /study-sessions`, `POST /study-sessions/:id/{pause,resume,end}`

**Statistics** — `GET /stats/overview`, `/stats/hours`, `/stats/mastery`,
`/stats/readiness`

**Settings** — `GET|PATCH /settings` (account) ·
`GET|PATCH /settings/devices/:deviceId` (per device)

**Search & home** — `GET /search?q=` · `GET /home` (the whole Home screen in
one round trip)

**Sharing** — `GET|POST /shares`, `DELETE /shares/:id` ·
`GET /shared/:token` *(public)*

Errors are always `{ "error": { "code", "message", "details?" } }`.

## Spaced repetition

`scheduleCard` in `src/domain/flashcards.ts` is a SuperMemo-2 derivative with
Anki-style learning steps, graded Again/Hard/Good/Easy (1–4) exactly as the
Flashcards screen shows.

- New cards walk 1 min → 10 min, then graduate at 1 day (4 days on Easy).
- In review, Good multiplies the interval by the ease factor; Hard uses 1.2 and
  drops ease; Easy adds a 1.3 bonus and raises it.
- Ease is clamped to [1.3, 3.0]; intervals cap at five years.
- A lapse sends the card to relearning keeping a fifth of its interval.

The function is pure — no I/O — which is what makes the long-run behaviour
testable. Test mode feeds the same scheduler (correct → Good, wrong → Again).

## Security

**Passwords** are argon2id at the OWASP floor (m=19 MiB, t=2, p=1). A login for
an unknown address still performs a real verification against a throwaway hash
generated at startup, so response time does not reveal which addresses are
registered.

**Sessions** are opaque 256-bit tokens stored only as SHA-256 hashes — a
database leak yields no usable cookie. They carry both a sliding idle window
(14 days) and an absolute cap (90 days). Changing a password revokes every
other session.

**CSRF** is defended three ways: `SameSite=Strict` on the session cookie, a
double-submit token compared in constant time, and `Origin` enforcement against
the allowlist on every state-changing request. Bearer-token callers skip the
CSRF check because no cookie is attached — a malicious page cannot make the
browser send an `Authorization` header.

**Authorisation** goes through one primitive per resource — `requireFile`,
`requireFolder`, `requireCard` and friends — which select on `id AND user_id`
together. Another account's id returns 404, not 403, so existence is never
disclosed. Ids are UUIDs, so they are not enumerable in the first place.

**Input** is parsed by zod at every boundary, including the document block list
and canvas object list, which are discriminated unions rather than free JSON.
Control characters, over-long fields and unknown enum values are rejected.
Every SQL statement uses bound parameters.

**Search** never passes user text into FTS5's query language. Each token is
emitted as a quoted, escaped phrase, so operators like `NEAR` or an unbalanced
quote are matched literally instead of altering the query or erroring.

**Uploads** are validated by magic bytes (`%PDF-`), not by the declared content
type or the filename. The stream is cut off at whichever binds first — the
per-upload cap or the account's remaining quota — written to a temp file, and
only moved into place once accepted. Storage keys are server-generated and
resolved through a path check that cannot escape the storage root. Downloads go
out with `nosniff`, an explicit `Content-Disposition` and `no-store`.

**Rate limiting** is global (per account when authenticated, per IP otherwise)
with tighter limits on credential and upload endpoints, plus account lockout
after repeated failures — tracked per account *and* per IP so one account under
attack does not lock out anyone else.

**Responses** never include password hashes or storage keys to unauthorised
callers, and unexpected errors return an opaque 500 with a request id while the
detail goes to the log. Log output redacts `authorization`, `cookie` and
`x-csrf-token`.

Anything a client could lie about is computed server-side: focus-timer elapsed
time comes from server clocks, and test scores are recomputed from the server's
own tally rather than trusted from the request body.

## Tests

```bash
npm test
```

100 tests: the scheduler across a long review history, and integration coverage
of every route group — including cross-account isolation on each resource type,
CSRF and origin rejection, brute-force lockout, magic-byte and quota
enforcement, FTS injection, optimistic-concurrency conflicts, and error
responses that leak nothing.

## Notes for the next person

- SQLite fits a single-node deployment well. The schema is ordinary SQL and the
  data layer is thin, so moving to Postgres is mostly swapping the driver;
  `search_index` would become `tsvector`.
- `page_count` on a PDF is set by the client after it parses the file
  (`PATCH /pdfs/:id`). Server-side extraction would let annotation page bounds
  be enforced on upload instead of on first write.
- Sharing is view-only by design; the `permission` column exists so an edit
  scope can be added without a migration.
- "Due" means two different things on purpose, and `domain/due.ts` is where the
  difference lives. Tiles that show a bare count include cards never studied;
  screens that put DUE next to NEW do not. They were hand-written predicates in
  four queries before, and had drifted.
