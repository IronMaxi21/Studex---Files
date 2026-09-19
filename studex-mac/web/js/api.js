/**
 * API client.
 *
 * The UI is served by the same process as the API, so requests are
 * same-origin and the session travels as an httpOnly cookie: the token never
 * touches JavaScript. What the client does hold is the CSRF token, which the
 * server sets in a readable cookie and expects echoed back in a header on
 * every state-changing request — the double-submit half of the server's
 * defence.
 */
import { log } from './log.js';

const CSRF_COOKIE = 'studex_csrf';
const CSRF_HEADER = 'x-csrf-token';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Listeners fired when the server reports the session is no longer valid.
 * Each is handed the server's error code, so 'session_replaced' — this account
 * signed in on another device — can be explained rather than blamed on an
 * expiry.
 */
const unauthorizedHandlers = new Set();
export function onUnauthorized(fn) { unauthorizedHandlers.add(fn); }
function notifyUnauthorized(code) { for (const fn of unauthorizedHandlers) fn(code ?? null); }

function readCsrfToken() {
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/* ── reachability ─────────────────────────────────────────────────────── */

/**
 * Whether the local server is answering.
 *
 * "Offline" here almost never means the internet: the server is a child
 * process on this Mac, and the times it cannot be reached are the seconds
 * after launch while it migrates the database, or the moment after a crash
 * before it is restarted. Both end on their own, which is why this is worth
 * showing rather than throwing.
 */
let reachable = true;
const reachabilityHandlers = new Set();

export function onReachabilityChange(fn) {
  reachabilityHandlers.add(fn);
  return () => reachabilityHandlers.delete(fn);
}

export const isReachable = () => reachable;

function setReachable(next) {
  if (reachable === next) return;
  reachable = next;
  for (const fn of reachabilityHandlers) {
    try { fn(next); } catch { /* a listener's problem is not the request's */ }
  }
}

/**
 * How many times to try, and how long to leave between tries.
 *
 * Only reads are repeated. A POST that creates a document may well have
 * succeeded with only its reply lost, and sending it again would make a second
 * document — so a write that fails at the transport is reported rather than
 * guessed at. The waits carry full jitter for the same reason the server's do.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 1_500;

/**
 * How long to wait for the server before giving up on one attempt.
 *
 * A refused connection fails at once; a *stalled* one — the socket open but no
 * bytes coming back, which is what a server hung mid-migration or a half-dropped
 * link looks like — would otherwise leave fetch waiting for ever and the pane
 * spinning on "Loading…". A timeout turns that stall into the same transport
 * failure a refusal is, so the retry loop above and the offline bar both see it.
 *
 * The default is generous for a server on this same Mac. The two things that
 * legitimately run long are given their own ceilings: model generation, and a
 * cloud sync moving a real library over the internet. Cutting either off at the
 * default would report a failure for work that was still succeeding.
 */
const DEFAULT_TIMEOUT_MS = 20_000;
const AI_TIMEOUT_MS = 120_000;
const SYNC_TIMEOUT_MS = 120_000;

const idempotent = (method) => method === 'GET' || method === 'HEAD';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, path, options = {}) {
  const attempts = idempotent(method) ? RETRY_ATTEMPTS : 1;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await attemptRequest(method, path, options);
      setReachable(true);
      return result;
    } catch (err) {
      last = err;
      // Only the transport failing is worth repeating. A 404 or a 422 is an
      // answer, and asking again produces the same one more slowly.
      const transport = err?.status === 0;
      if (transport) setReachable(false);
      if (!transport || attempt === attempts) throw err;
      await sleep(Math.round(Math.random() * Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1))));
    }
  }
  throw last;
}

async function attemptRequest(method, path, { body, query, raw, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  let url = path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers = {};
  const init = { method, headers, credentials: 'same-origin' };

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body; // let the browser set the multipart boundary
    } else {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }

  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCsrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  // Abort the attempt if the server goes quiet for longer than `timeout`. The
  // guard covers reading the body too, not just the first response, so a reply
  // that begins and then stalls mid-stream is caught as well. A raw response is
  // the exception: its body is handed back for the caller to stream, so once the
  // headers are in the clock is stopped and the download runs untimed.
  const controller = timeout ? new AbortController() : null;
  let timedOut = false;
  const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeout) : 0;
  if (controller) init.signal = controller.signal;
  // The transport failing — refused, reset, or aborted for taking too long — is
  // status 0, which is what the retry loop repeats on and what flips the offline
  // bar. A timeout is that same failure, only named so a caller can tell a slow
  // server from an absent one.
  const transportError = (cause) => timedOut
    ? new ApiError(0, 'timeout', 'The Studex server took too long to respond.', { cause: String(cause) })
    : new ApiError(0, 'network_error', 'Cannot reach the Studex server.', { cause: String(cause) });

  try {
    let res;
    try {
      res = await fetch(url, init);
    } catch (cause) {
      throw transportError(cause);
    }

    if (raw) {
      if (!res.ok) {
        const failure = await toError(res);
        if (res.status === 401) notifyUnauthorized(failure.code);
        throw failure;
      }
      return res;
    }

    if (res.status === 204) return null;

    let text;
    try {
      text = await res.text();
    } catch (cause) {
      throw transportError(cause);
    }
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }

    if (!res.ok) {
      const err = payload?.error;
      if (res.status === 401) notifyUnauthorized(err?.code);
      throw new ApiError(
        res.status,
        err?.code ?? 'error',
        err?.message ?? `Request failed (${res.status})`,
        err?.details,
      );
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An upload that says how far along it is.
 *
 * fetch cannot report upload progress — the request body is a stream it will
 * not narrate — so this one call is made with XMLHttpRequest instead. It is
 * the same request the rest of the client would make: same-origin, the CSRF
 * token echoed back, and failures raised as ApiError so callers do not have to
 * know which transport carried it.
 *
 * Never retried. A repeated POST of a fifty-megabyte PDF is a second copy of
 * that PDF in the library, which is worse than being told it failed.
 *
 * A big upload has no fixed duration, so a total-time limit would punish a
 * slow-but-healthy connection. What marks a dead one is silence: no bytes moving
 * and no response for a stretch. A watchdog reset by every progress tick catches
 * a connection dropped mid-transfer — the alternative is a bar that sticks at
 * forty percent for ever — while its window is long enough that a server taking
 * its time to process a received file is not mistaken for a broken link.
 */
export function upload(path, formData, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.withCredentials = true;
    const csrf = readCsrfToken();
    if (csrf) xhr.setRequestHeader(CSRF_HEADER, csrf);

    const STALL_MS = 60_000;
    let watchdog = 0;
    let stalled = false;
    const kick = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { stalled = true; xhr.abort(); }, STALL_MS);
    };
    const stopWatch = () => clearTimeout(watchdog);

    xhr.upload.addEventListener('progress', (event) => {
      kick();
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      stopWatch();
      setReachable(true);
      let payload = null;
      try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { /* not JSON */ }
      if (xhr.status === 401) notifyUnauthorized(payload?.error?.code);
      if (xhr.status >= 200 && xhr.status < 300) { resolve(payload); return; }
      const err = payload?.error;
      reject(new ApiError(
        xhr.status,
        err?.code ?? 'error',
        err?.message ?? `Request failed (${xhr.status})`,
        err?.details,
      ));
    });
    const failed = () => {
      stopWatch();
      setReachable(false);
      reject(new ApiError(0, 'network_error', 'Cannot reach the Studex server.'));
    };
    xhr.addEventListener('error', failed);
    xhr.addEventListener('timeout', failed);
    // An abort we caused because the transfer went quiet is a dropped connection,
    // not a cancellation, and reads as one; an abort from anywhere else is a user
    // walking away from the upload.
    xhr.addEventListener('abort', () => {
      stopWatch();
      if (stalled) { failed(); return; }
      reject(new ApiError(0, 'aborted', 'The upload was cancelled.'));
    });
    kick();
    xhr.send(formData);
  });
}

async function toError(res) {
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON body */ }
  const err = payload?.error;
  return new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status})`, err?.details);
}

const get = (path, query) => request('GET', path, { query });
const post = (path, body) => request('POST', path, { body });
const patch = (path, body) => request('PATCH', path, { body });
const put = (path, body) => request('PUT', path, { body });
const del = (path) => request('DELETE', path);

/** POSTs whose work runs long on purpose: model generation, cloud sync. */
const postAI = (path, body) => request('POST', path, { body, timeout: AI_TIMEOUT_MS });
const postSync = (path, body) => request('POST', path, { body, timeout: SYNC_TIMEOUT_MS });

export const api = {
  raw: request,

  /* auth */
  login: (email, password) => post('/api/auth/login', { email, password }),
  register: (email, password, displayName) => post('/api/auth/register', { email, password, displayName }),
  authStatus: () => get('/api/auth/status'),

  /** Is the server there? Used by the offline watcher, so it never retries itself. */
  health: () => get('/health'),

  /* updates */
  updateState: () => get('/api/updates'),
  checkUpdate: (body = {}) => post('/api/updates/check', body),

  /* cloud sync */
  syncStatus: () => get('/api/sync/status'),
  runSync: () => postSync('/api/sync'),
  pullSync: () => postSync('/api/sync/pull'),
  pushSync: () => postSync('/api/sync/push'),
  logout: () => post('/api/auth/logout'),
  me: () => get('/api/auth/me'),
  planStatus: () => get('/api/auth/me/plan'),
  setPlan: (plan) => patch('/api/auth/me/plan', { plan }),

  /** Whether this install sells anything, and for how much. */
  billingConfig: () => get('/api/billing/config'),
  /** Answers with a URL to open. Grants nothing: the webhook does that. */
  startCheckout: () => post('/api/billing/checkout', {}),
  /** Where a subscription is changed or cancelled. */
  billingPortal: () => post('/api/billing/portal', {}),

  /** Whether this install has an AI at all, and how much of the month is left. */
  aiStatus: () => get('/api/ai/status'),
  /**
   * Cards from a passage, a note, or the marked-up pages of a PDF.
   * `commit: false` hands them back to be looked at instead of writing them.
   */
  aiCards: (body) => postAI('/api/ai/cards', body),
  /** An explanation of one passage. Writes nothing. */
  aiExplain: (body) => postAI('/api/ai/explain', body),
  /** An ordered set of study blocks. Writes nothing unless `commit` is true. */
  aiRevisionPlan: (body) => postAI('/api/ai/revision-plan', body),
  /** Saves the Google AI Studio (Gemini) key this install calls with. Only its last four characters ever come back. */
  aiSetKey: (key, verify = true) => request('PUT', '/api/ai/key', { body: { key, verify }, timeout: AI_TIMEOUT_MS }),
  aiClearKey: () => del('/api/ai/key'),
  /** Every model call behind the last few requests, newest first. */
  aiCalls: () => get('/api/ai/calls'),
  /** A specification's pages of text in; a proposed list of units and topics out. Writes nothing. */
  aiSpecUnpack: (body) => postAI('/api/ai/spec/unpack', body),
  /** Multiple-choice questions on some material or a topic. Writes nothing. */
  aiQuiz: (body) => postAI('/api/ai/quiz', body),
  aiMark: (body) => postAI('/api/ai/quiz/mark', body),
  aiChat: (body) => postAI('/api/ai/chat', body),
  aiChats: () => get('/api/ai/chats'),
  aiChatGet: (id) => get(`/api/ai/chats/${encodeURIComponent(id)}`),
  aiChatDelete: (id) => del(`/api/ai/chats/${encodeURIComponent(id)}`),
  aiChatsClear: () => del('/api/ai/chats'),
  /** Groups of topics that look like the same thing twice. Writes nothing. */
  aiDedupe: (body) => postAI('/api/ai/topics/dedupe', body),
  sessions: () => get('/api/auth/sessions'),
  revokeOtherSessions: () => del('/api/auth/sessions'),
  changePassword: (currentPassword, newPassword) => post('/api/auth/change-password', { currentPassword, newPassword }),

  /* home + search */
  home: () => get('/api/home'),
  search: (q, opts = {}) => get('/api/search', { q, limit: opts.limit, types: opts.types?.join(',') }),
  searchCorpus: () => get('/api/search/corpus'),

  /* library */
  subjects: () => get('/api/subjects'),
  createSubject: (body) => post('/api/subjects', body),
  updateSubject: (id, body) => patch(`/api/subjects/${id}`, body),
  folders: () => get('/api/folders'),
  createFolder: (body) => post('/api/folders', body),
  updateFolder: (id, body) => patch(`/api/folders/${id}`, body),
  deleteFolder: (id) => del(`/api/folders/${id}`),
  files: (query) => get('/api/files', query),
  /**
   * Every file, not the first page of them.
   *
   * The list endpoint caps a page at 200, and both callers asked for one page
   * and treated it as the whole library. A student past two hundred files had
   * the rest quietly disappear from the sidebar, the library and everything
   * else reading from them — the files were all still there, and the app was
   * simply not looking at them.
   */
  allFiles: async (query = {}) => {
    const PAGE = 200;
    // A ceiling only so a bug upstream cannot spin here for ever. It is far
    // past any real library, and passing it is worth a line in the console.
    const CEILING = 20_000;
    const files = [];
    for (let offset = 0; offset < CEILING; offset += PAGE) {
      const page = await get('/api/files', { ...query, limit: PAGE, offset });
      files.push(...page.files);
      if (page.files.length < PAGE) return { files };
    }
    log.warn(`stopped reading the library at ${CEILING} files`);
    return { files };
  },
  createFile: (body) => post('/api/files', body),
  file: (id) => get(`/api/files/${id}`),
  /** What a file holds, without opening it: first lines, first cards, highlights, a sketch. */
  filePreview: (id) => get(`/api/files/${id}/preview`),
  updateFile: (id, body) => patch(`/api/files/${id}`, body),
  trashFile: (id) => del(`/api/files/${id}`),
  restoreFile: (id) => post(`/api/files/${id}/restore`),
  purgeFile: (id) => del(`/api/files/${id}/purge`),
  /** The states a file was in before sync or a restore replaced them, newest first. */
  fileRevisions: (id) => get(`/api/files/${id}/revisions`),
  restoreRevision: (id, revisionId) => post(`/api/files/${id}/revisions/${revisionId}/restore`),
  storage: () => get('/api/storage'),

  /* documents + canvas */
  document: (id) => get(`/api/documents/${id}`),
  saveDocument: (id, blocks, expectedRevision, style) => put(`/api/documents/${id}`, { blocks, expectedRevision, style }),
  outline: (id) => get(`/api/documents/${id}/outline`),
  documentDeck: (id) => post(`/api/documents/${id}/deck`),
  /** Pages whose [[links]] name this one. */
  backlinks: (id) => get(`/api/documents/${id}/backlinks`),
  /* tags: the second axis of the library, across folders and files alike */
  /** Every tag in the account, with how many folders and files carry each. */
  tags: () => get('/api/tags'),
  tagLinks: () => get('/api/tags/links'),
  /** One tag and everything on it. */
  tagged: (name) => get(`/api/tags/by-name/${encodeURIComponent(name)}`),
  createTag: (name, color = null) => post('/api/tags', { name, color }),
  updateTag: (id, changes) => patch(`/api/tags/${id}`, changes),
  deleteTag: (id) => del(`/api/tags/${id}`),
  /** The tags on one thing, and everything that shares them. */
  tagsOn: (itemType, itemId) => get(`/api/tags/on/${itemType}/${itemId}`),
  attachTag: ({ tagId = null, name = null, itemType, itemId }) =>
    post('/api/tags/attach', { ...(tagId ? { tagId } : { name }), itemType, itemId }),
  detachTag: (tagId, itemType, itemId) => del(`/api/tags/${tagId}/on/${itemType}/${itemId}`),
  /** Resolves a [[link]] to a page, or null when nothing carries that title. */
  documentByTitle: (title) => get(`/api/documents/by-title/${encodeURIComponent(title)}`),
  canvas: (id) => get(`/api/canvases/${id}`),
  saveCanvas: (id, objects, viewport, expectedRevision, background) =>
    put(`/api/canvases/${id}`, { objects, viewport, expectedRevision, background }),

  /* images inside documents */
  uploadImage: (fileId, formData) => post(`/api/documents/${fileId}/images`, formData),
  uploadDeckImage: (deckId, formData) => post(`/api/decks/${deckId}/images`, formData),
  occlusionCards: (deckId, body) => post(`/api/decks/${deckId}/occlusion`, body),
  imageContentUrl: (id) => `/api/images/${id}/content`,
  deleteImage: (id) => del(`/api/images/${id}`),

  /* pdf */
  uploadPdf: (formData) => post('/api/pdfs', formData),
  /** The same upload, narrated — used by the drop import, which shows a bar. */
  uploadPdfProgress: (formData, onProgress) => upload('/api/pdfs', formData, { onProgress }),
  pdf: (id) => get(`/api/pdfs/${id}`),
  updatePdf: (id, body) => patch(`/api/pdfs/${id}`, body),
  pdfContentUrl: (id) => `/api/pdfs/${id}/content`,
  annotations: (id) => get(`/api/pdfs/${id}/annotations`),
  createAnnotation: (id, body) => post(`/api/pdfs/${id}/annotations`, body),
  updateAnnotation: (id, annotationId, body) => patch(`/api/pdfs/${id}/annotations/${annotationId}`, body),
  deleteAnnotation: (id, annotationId) => del(`/api/pdfs/${id}/annotations/${annotationId}`),
  cardsFromHighlights: (id, body) => post(`/api/pdfs/${id}/cards-from-highlights`, body ?? {}),

  /* flashcards */
  deckCards: (id, query) => get(`/api/decks/${id}/cards`, query),
  deckStats: (id) => get(`/api/decks/${id}/stats`),
  deckTemplate: (id) => get(`/api/decks/${id}/template`),
  setDeckTemplate: (id, template) => put(`/api/decks/${id}/template`, { template }),
  importPack: (body) => post('/api/packs/import', body),
  sharedDeckPack: (token, id) => get(`/api/shared/${encodeURIComponent(token)}/decks/${id}/pack`),
  createCard: (body) => post('/api/cards', body),
  updateCard: (id, body) => patch(`/api/cards/${id}`, body),
  deleteCard: (id) => del(`/api/cards/${id}`),
  studyQueue: (query) => get('/api/study/queue', query),
  studyToday: () => get('/api/study/today'),
  review: (id, rating, durationMs, mode) => post(`/api/cards/${id}/review`, { rating, durationMs, mode }),
  startTest: (body) => post('/api/tests', body),
  test: (id) => get(`/api/tests/${id}`),
  answerTest: (id, body) => post(`/api/tests/${id}/answers`, body),
  endTest: (id) => post(`/api/tests/${id}/end`),

  /* mock exams */
  mocks: () => get('/api/mocks'),
  startMock: (body) => post('/api/mocks', body),
  mock: (id) => get(`/api/mocks/${id}`),
  answerMock: (id, body) => post(`/api/mocks/${id}/answers`, body),
  finishMock: (id) => post(`/api/mocks/${id}/finish`),

  /* calendar + timer */
  events: (query) => get('/api/events', query),
  createEvent: (body) => post('/api/events', body),
  scheduler: () => get('/api/scheduler'),
  tuneScheduler: () => post('/api/scheduler/tune', {}),
  resetScheduler: () => del('/api/scheduler/tune'),
  draftRevisionPlan: (id, body) => post(`/api/events/${id}/revision-plan/draft`, body),
  revisionPlan: (id) => get(`/api/events/${id}/revision-plan`),
  acceptRevisionPlan: (id, body) => put(`/api/events/${id}/revision-plan`, body),
  clearRevisionPlan: (id) => del(`/api/events/${id}/revision-plan`),
  updateEvent: (id, body) => patch(`/api/events/${id}`, body),
  deleteEvent: (id) => del(`/api/events/${id}`),
  upcoming: (limit) => get('/api/events/upcoming', { limit }),
  todaysPlan: (from, to) => get('/api/plan/today', { from, to }),
  activeSession: () => get('/api/study-sessions/active'),
  startSession: (body) => post('/api/study-sessions', body ?? {}),
  pauseSession: (id) => post(`/api/study-sessions/${id}/pause`),
  resumeSession: (id) => post(`/api/study-sessions/${id}/resume`),
  endSession: (id, status) => post(`/api/study-sessions/${id}/end`, { status: status ?? 'completed' }),
  markSessionGoal: (id, met) => post(`/api/study-sessions/${id}/goal`, { met }),
  sessionGoals: () => get('/api/study-sessions/goals'),
  statsHoursBySubject: (query) => get('/api/stats/hours-by-subject', query),
  statsTerm: (query) => get('/api/stats/term', query),

  /* timetable — the repeating week A / week B pattern */
  timetable: () => get('/api/timetable'),
  setPeriods: (periods) => put('/api/timetable/periods', { periods }),
  setWeekAnchor: (weekAStart) => put('/api/timetable/anchor', { weekAStart }),
  putLesson: (body) => put('/api/timetable/lessons', body),
  deleteLesson: (id) => del(`/api/timetable/lessons/${id}`),
  clearWeek: (week) => del(`/api/timetable/weeks/${week}`),
  copyWeek: (week) => post(`/api/timetable/weeks/${week}/copy`),
  lessonsBetween: (from, to) => get('/api/timetable/lessons', { from, to }),

  /* topic matrix */
  topics: (query) => get('/api/topics', query),
  createTopic: (body) => post('/api/topics', body),
  importTopics: (body) => post('/api/topics/import', body),
  /** Folds `mergeIds` into `keepId`: ratings and notes move, the others are deleted. */
  mergeTopics: (keepId, mergeIds) => post('/api/topics/merge', { keepId, mergeIds }),
  updateTopic: (id, body) => patch(`/api/topics/${id}`, body),
  rateTopic: (id, confidence) => post(`/api/topics/${id}/rate`, { confidence }),
  topicHistory: (id) => get(`/api/topics/${id}/history`),
  deleteTopic: (id) => del(`/api/topics/${id}`),

  /* stats */
  statsOverview: () => get('/api/stats/overview'),
  statsHours: (query) => get('/api/stats/hours', query),
  statsMastery: () => get('/api/stats/mastery'),
  statsReadiness: () => get('/api/stats/readiness'),
  statsNeedsWork: () => get('/api/stats/needs-work'),

  /* settings */
  /** What this build offers: the developer screens, the layout choice, beta releases. */
  capabilities: () => get('/api/capabilities'),

  settings: () => get('/api/settings'),
  updateSettings: (body) => patch('/api/settings', body),
  deviceSettings: (deviceId) => get(`/api/settings/devices/${deviceId}`),
  updateDeviceSettings: (deviceId, body) => patch(`/api/settings/devices/${deviceId}`, body),

  /* sharing */
  shares: () => get('/api/shares'),
  createShare: (body) => post('/api/shares', body),
  deleteShare: (id) => del(`/api/shares/${id}`),

  /* Reading a share by its link. These need no session — the token is the
     credential — and the server answers with the permission the link carries,
     so the caller knows whether to open an editor or a read-only page. */
  resolveShare: (token) => get(`/api/shared/${token}`),
  sharedDocument: (token, id) => get(`/api/shared/${token}/documents/${id}`),
  saveSharedDocument: (token, id, body) => put(`/api/shared/${token}/documents/${id}`, body),
  /** An image inside a shared document. Scoped to that document, not to the
      owner's whole library, so it can be handed to an <img src> safely. */
  sharedImageUrl: (token, docId, imageId) =>
    `/api/shared/${token}/documents/${docId}/images/${imageId}/content`,
  sharedCanvas: (token, id) => get(`/api/shared/${token}/canvases/${id}`),
  saveSharedCanvas: (token, id, body) => put(`/api/shared/${token}/canvases/${id}`, body),
};
