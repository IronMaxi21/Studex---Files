/**
 * The revision half of the app: the fortnightly timetable pattern, the topic
 * matrix that decides when to come back to something, and the calendar kinds
 * that let the two be read on one screen.
 *
 * The interesting assertions here are about arithmetic that a screen cannot
 * check for itself — which week a date falls in once the anchor moves, how far
 * ahead a rating pushes the next due date, and what "due" means for a topic
 * nobody has judged yet.
 */
import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, closeApp, getApp, registerUser, type Client } from './helpers.js';
import { mondayOf, weekOf } from '../src/domain/timetable.js';
import { nextDue, CONFIDENCE_DAYS } from '../src/domain/topics.js';

const DAY = 86_400_000;

let student: Client;

before(async () => {
  await getApp();
  student = await registerUser('Rev Ision');
});

after(async () => {
  await closeApp();
});

/* -------------------------------------------------------------------------- */

describe('the fortnightly pattern', () => {
  it('counts A and B weeks either side of the anchor', () => {
    const anchor = mondayOf(Date.now());
    assert.equal(weekOf(anchor, anchor), 'A');
    assert.equal(weekOf(anchor, anchor + 3 * DAY), 'A', 'the rest of the anchor week is still A');
    assert.equal(weekOf(anchor, anchor + 7 * DAY), 'B');
    assert.equal(weekOf(anchor, anchor + 14 * DAY), 'A');
    assert.equal(weekOf(anchor, anchor - 7 * DAY), 'B', 'last term alternates too');
    assert.equal(weekOf(null, anchor), 'A', 'without an anchor everything is week A');
  });

  it('seeds a school day on first read', async () => {
    const res = await api(student, { method: 'GET', url: '/api/timetable' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.periods.length >= 8, 'a day is seeded rather than left blank');
    assert.equal(body.periods[0].idx, 0);
    assert.deepEqual(body.lessons, []);
    assert.ok(body.currentWeek === 'A' || body.currentWeek === 'B');
  });

  it('upserts a lesson into a cell rather than stacking two in it', async () => {
    const cell = { week: 'A', day: 0, period: 1 };
    const first = await api(student, {
      method: 'PUT',
      url: '/api/timetable/lessons',
      payload: { ...cell, subject: 'Chemistry', room: 'S4', color: 'teal' },
    });
    assert.equal(first.statusCode, 200);

    const second = await api(student, {
      method: 'PUT',
      url: '/api/timetable/lessons',
      payload: { ...cell, subject: 'Physics', room: 'S6' },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().lesson.id, first.json().lesson.id, 'the same cell, edited');
    assert.equal(second.json().lesson.subject, 'Physics');

    const all = (await api(student, { method: 'GET', url: '/api/timetable' })).json().lessons;
    assert.equal(all.filter((l: { week: string; day: number; period: number }) =>
      l.week === 'A' && l.day === 0 && l.period === 1).length, 1);
  });

  it('copies one week over the other', async () => {
    const res = await api(student, { method: 'POST', url: '/api/timetable/weeks/A/copy' });
    assert.equal(res.statusCode, 200);
    const weekB = res.json().lessons;
    assert.equal(weekB.length, 1);
    assert.equal(weekB[0].week, 'B');
    assert.equal(weekB[0].subject, 'Physics');
  });

  it('places the pattern on real dates, and follows the anchor when it moves', async () => {
    const anchor = mondayOf(Date.now());
    await api(student, {
      method: 'PUT',
      url: '/api/timetable/anchor',
      payload: { weekAStart: anchor },
    });

    /* Week A's Monday lesson is Physics; week B's is the copy, also Physics, so
       tell them apart by giving week B's Monday a different subject. */
    await api(student, {
      method: 'PUT',
      url: '/api/timetable/lessons',
      payload: { week: 'B', day: 0, period: 1, subject: 'Biology' },
    });

    const placed = (
      await api(student, {
        method: 'GET',
        url: `/api/timetable/lessons?from=${anchor}&to=${anchor + 13 * DAY}`,
      })
    ).json().lessons;

    const mondays = placed.filter((l: { starts_at: number }) => l.starts_at < anchor + 14 * DAY);
    assert.equal(mondays.length, 2, 'one Monday lesson in each week of the fortnight');
    assert.equal(mondays[0].subject, 'Physics');
    assert.equal(mondays[1].subject, 'Biology');
    assert.ok(mondays[0].label.length > 0, 'the period label rides along for the calendar');
    assert.ok(mondays[0].ends_at > mondays[0].starts_at);

    /* Moving the anchor a week moves every lesson at once. */
    await api(student, {
      method: 'PUT',
      url: '/api/timetable/anchor',
      payload: { weekAStart: anchor - 7 * DAY },
    });
    const shifted = (
      await api(student, {
        method: 'GET',
        url: `/api/timetable/lessons?from=${anchor}&to=${anchor + 6 * DAY}`,
      })
    ).json().lessons;
    assert.equal(shifted.length, 1);
    assert.equal(shifted[0].subject, 'Biology', 'this week is now a B week');
  });

  it('will not enumerate a decade', async () => {
    const from = mondayOf(Date.now());
    const res = await api(student, {
      method: 'GET',
      url: `/api/timetable/lessons?from=${from}&to=${from + 3650 * DAY}`,
    });
    assert.equal(res.statusCode, 200);
    const days = new Set(
      res.json().lessons.map((l: { starts_at: number }) => new Date(l.starts_at).toDateString()),
    );
    assert.ok(days.size <= 120, 'the range is capped at a term of days');
  });

  it('clears a week without touching the other', async () => {
    const res = await api(student, { method: 'DELETE', url: '/api/timetable/weeks/B' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().cleared >= 1);
    const left = (await api(student, { method: 'GET', url: '/api/timetable' })).json().lessons;
    assert.ok(left.every((l: { week: string }) => l.week === 'A'));
  });

  it('rejects a week that is neither A nor B', async () => {
    const res = await api(student, { method: 'DELETE', url: '/api/timetable/weeks/C' });
    assert.equal(res.statusCode, 422);
  });
});

/* -------------------------------------------------------------------------- */

describe('the topic matrix', () => {
  let subject: { id: string };
  let topic: {
    id: string;
    name: string;
    confidence: number;
    last_rated_at: number | null;
    next_due_at: number | null;
  };

  before(async () => {
    subject = (
      await api(student, { method: 'POST', url: '/api/subjects', payload: { name: 'Physics A' } })
    ).json().subject;
  });

  it('gives the client the schedule it is about to explain', async () => {
    const body = (await api(student, { method: 'GET', url: '/api/topics' })).json();
    assert.deepEqual(body.confidenceDays, [1, 3, 7, 16, 35]);
    assert.equal(body.confidenceLabels.length, 5);
    assert.deepEqual(body.summary, { total: 0, unrated: 0, due: 0, shaky: 0, solid: 0 });
  });

  it('treats a brand-new topic as unrated and already due', async () => {
    const res = await api(student, {
      method: 'POST',
      url: '/api/topics',
      payload: { name: 'Circular motion', subjectId: subject.id, unit: 'Paper 1' },
    });
    assert.equal(res.statusCode, 201);
    topic = res.json().topic;
    assert.equal(topic.confidence, 0);
    assert.equal(topic.next_due_at, null);
    assert.equal(topic.last_rated_at, null);

    const due = (await api(student, { method: 'GET', url: '/api/topics?due=true' })).json();
    assert.ok(due.topics.some((t: { id: string }) => t.id === topic.id));
    assert.equal(due.summary.unrated, 1);
    assert.equal(due.summary.due, 1);
  });

  it('computes the next due date from the rating, and records the rating', async () => {
    const before = Date.now();
    const res = await api(student, {
      method: 'POST',
      url: `/api/topics/${topic.id}/rate`,
      payload: { confidence: 3 },
    });
    assert.equal(res.statusCode, 200);
    const rated = res.json().topic;
    assert.equal(rated.confidence, 3);
    assert.ok(rated.next_due_at >= before + 7 * DAY, 'a 3 buys a week');
    assert.ok(rated.next_due_at <= Date.now() + 7 * DAY);
    assert.equal(rated.days_until, 7);
    assert.equal(rated.overdue, false);

    const history = (
      await api(student, { method: 'GET', url: `/api/topics/${topic.id}/history` })
    ).json().ratings;
    assert.equal(history.length, 1);
    assert.equal(history[0].confidence, 3);

    /* Rating it again is a second look, not an edit of the first one. */
    await api(student, {
      method: 'POST',
      url: `/api/topics/${topic.id}/rate`,
      payload: { confidence: 5 },
    });
    const again = (
      await api(student, { method: 'GET', url: `/api/topics/${topic.id}/history` })
    ).json().ratings;
    assert.equal(again.length, 2);
    assert.equal(again[0].confidence, 5, 'newest first');
  });

  it('drops a rated topic out of the due list', async () => {
    const due = (await api(student, { method: 'GET', url: '/api/topics?due=true' })).json();
    assert.ok(!due.topics.some((t: { id: string }) => t.id === topic.id));
    assert.equal(due.summary.due, 0);
    assert.equal(due.summary.solid, 1);
  });

  it('refuses a confidence outside the five steps, and refuses to be told a due date', async () => {
    for (const confidence of [0, 6, 2.5]) {
      const res = await api(student, {
        method: 'POST',
        url: `/api/topics/${topic.id}/rate`,
        payload: { confidence },
      });
      assert.equal(res.statusCode, 422, `confidence ${confidence} should not be accepted`);
    }

    /* next_due_at is a consequence, never an input: a client that posts one is
       ignored rather than obeyed. */
    const patched = await api(student, {
      method: 'PATCH',
      url: `/api/topics/${topic.id}`,
      payload: { name: 'Circular motion', nextDueAt: Date.now() + 999 * DAY },
    });
    assert.equal(patched.statusCode, 200);
    assert.ok(patched.json().topic.next_due_at < Date.now() + 40 * DAY);
  });

  it('imports a specification and skips what is already there', async () => {
    const res = await api(student, {
      method: 'POST',
      url: '/api/topics/import',
      payload: {
        subjectId: subject.id,
        unit: 'Paper 2',
        names: ['Simple harmonic motion', 'Gravitational fields', 'circular motion'],
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.created.length, 2);
    assert.equal(body.skipped, 1, 'a name already in the matrix is matched case-insensitively');
    assert.ok(body.created.every((t: { unit: string }) => t.unit === 'Paper 2'));
  });

  it('counts the shape of the course', async () => {
    const summary = (await api(student, { method: 'GET', url: '/api/topics' })).json().summary;
    assert.equal(summary.total, 3);
    assert.equal(summary.unrated, 2);
    assert.equal(summary.due, 2, 'the two unrated ones');
    assert.equal(summary.solid, 1);
    assert.equal(summary.shaky, 0);
  });

  it('sorts the unrated to the front, then by how overdue', async () => {
    const topics = (await api(student, { method: 'GET', url: '/api/topics' })).json().topics;
    assert.equal(topics[0].confidence, 0);
    assert.equal(topics.at(-1).id, topic.id, 'the one with the furthest due date is last');
  });

  it('filters by subject', async () => {
    const other = (
      await api(student, { method: 'POST', url: '/api/subjects', payload: { name: 'Latin' } })
    ).json().subject;
    await api(student, {
      method: 'POST',
      url: '/api/topics',
      payload: { name: 'Ablative absolute', subjectId: other.id },
    });

    const mine = (
      await api(student, { method: 'GET', url: `/api/topics?subjectId=${other.id}` })
    ).json().topics;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, 'Ablative absolute');
  });

  it('takes a topic and its ratings away together', async () => {
    const res = await api(student, { method: 'DELETE', url: `/api/topics/${topic.id}` });
    assert.equal(res.statusCode, 204);
    const history = await api(student, {
      method: 'GET',
      url: `/api/topics/${topic.id}/history`,
    });
    assert.equal(history.statusCode, 404);
  });

  it("hides one student's matrix from another", async () => {
    const other = await registerUser('Someone Else Entirely');
    const list = (await api(other, { method: 'GET', url: '/api/topics' })).json();
    assert.equal(list.topics.length, 0);
    assert.equal(list.summary.total, 0);
  });
});

/* -------------------------------------------------------------------------- */

describe('nextDue', () => {
  it('matches the schedule the screen promises', () => {
    const from = 1_700_000_000_000;
    CONFIDENCE_DAYS.forEach((days, i) => {
      assert.equal(nextDue(i + 1, from), from + days * DAY);
    });
  });

  it('has no answer for a confidence that is not a rating', () => {
    assert.equal(nextDue(0), null);
    assert.equal(nextDue(6), null);
  });
});

/* -------------------------------------------------------------------------- */

describe('calendar kinds', () => {
  it('accepts a personal event alongside the school ones', async () => {
    const res = await api(student, {
      method: 'POST',
      url: '/api/events',
      payload: { kind: 'personal', title: "Dad's birthday", startsAt: Date.now() + DAY, allDay: true },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().event.kind, 'personal');
  });

  it('re-files an event that was entered under the wrong kind', async () => {
    const event = (
      await api(student, {
        method: 'POST',
        url: '/api/events',
        payload: { kind: 'class', title: 'Physics catch-up', startsAt: Date.now() + 2 * DAY },
      })
    ).json().event;

    const res = await api(student, {
      method: 'PATCH',
      url: `/api/events/${event.id}`,
      payload: { kind: 'study_block' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().event.kind, 'study_block');
  });

  it('refuses a kind it has never heard of', async () => {
    const res = await api(student, {
      method: 'POST',
      url: '/api/events',
      payload: { kind: 'detention', title: 'Nope', startsAt: Date.now() },
    });
    assert.equal(res.statusCode, 422);
  });
});
