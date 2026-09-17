import { getDb, tx } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireSubject } from './library.js';
import { inLiveDeck } from './due.js';
import { reviewCard, type CardRow } from './flashcards.js';
import { rateTopic } from './topics.js';

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

export interface MockExamRow {
  id: string;
  user_id: string;
  subject_id: string | null;
  title: string;
  duration_min: number;
  score_pct: number | null;
  started_at: number;
  ended_at: number | null;
}

export interface MockQuestionRow {
  id: string;
  exam_id: string;
  user_id: string;
  card_id: string | null;
  topic: string | null;
  prompt: string;
  answer: string;
  position: number;
  correct: number | null;
  answered_at: number | null;
}

/** One line of the per-topic breakdown a finished paper produces. */
export interface TopicResult {
  topic: string;
  correct: number;
  total: number;
  pct: number;
  /** The confidence (1–5) the paper re-rated the matching topic to, when one matched. */
  confidence: number | null;
}

export interface MockExam extends MockExamRow {
  questions: MockQuestionRow[];
  answered: number;
  breakdown: TopicResult[];
}

/* -------------------------------------------------------------------------- */
/* Assembling a paper                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The subject's live, unsuspended cards — resolved through the folder chain the
 * same way the study queue resolves a subject (a card's subject is inherited
 * from the nearest ancestor folder that carries one, never stored on the card).
 */
function subjectCards(userId: string, subjectId: string): CardRow[] {
  return getDb()
    .prepare<[string, string, string], CardRow>(
      `SELECT c.* FROM cards c
        WHERE c.user_id = ?
          AND c.suspended = 0
          AND c.occlusion IS NULL -- a hidden region is not a written question
          AND ${inLiveDeck('c')}
          AND c.deck_id IN (
            WITH RECURSIVE subj_chain(file_id, subject_id, parent_id) AS (
              SELECT f.id, fo.subject_id, fo.parent_id
                FROM files f JOIN folders fo ON fo.id = f.folder_id
               WHERE f.user_id = ?
              UNION ALL
              SELECT sc.file_id, up.subject_id, up.parent_id
                FROM subj_chain sc JOIN folders up ON up.id = sc.parent_id
               WHERE sc.subject_id IS NULL
            )
            SELECT file_id FROM subj_chain WHERE subject_id = ?
          )`,
    )
    .all(userId, userId, subjectId);
}

/** Fisher–Yates, so the paper is a fresh mix each sitting rather than deck order. */
function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function startMockExam(
  userId: string,
  input: { subjectId: string; count: number; durationMin: number },
): MockExam {
  const subject = requireSubject(userId, input.subjectId);
  const pool = subjectCards(userId, input.subjectId);
  if (pool.length === 0) {
    throw badRequest('This subject has no cards yet — add some before sitting a mock.');
  }

  const picked = shuffled(pool).slice(0, Math.min(input.count, pool.length));
  const id = newId();
  const now = Date.now();

  return tx(() => {
    getDb()
      .prepare(
        `INSERT INTO mock_exams (id, user_id, subject_id, title, duration_min, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, subject.id, `${subject.name} mock`, input.durationMin, now);

    const insert = getDb().prepare(
      `INSERT INTO mock_exam_questions
         (id, exam_id, user_id, card_id, topic, prompt, answer, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    picked.forEach((card, i) => {
      insert.run(newId(), id, userId, card.id, card.topic, card.front, card.back, i);
    });

    return getMockExam(userId, id);
  });
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

function requireExam(userId: string, examId: string): MockExamRow {
  const row = getDb()
    .prepare<[string, string], MockExamRow>(
      'SELECT * FROM mock_exams WHERE id = ? AND user_id = ?',
    )
    .get(examId, userId);
  if (!row) throw notFound('Mock exam not found');
  return row;
}

function questionsOf(examId: string): MockQuestionRow[] {
  return getDb()
    .prepare<[string], MockQuestionRow>(
      'SELECT * FROM mock_exam_questions WHERE exam_id = ? ORDER BY position',
    )
    .all(examId);
}

export function getMockExam(userId: string, examId: string): MockExam {
  const exam = requireExam(userId, examId);
  const questions = questionsOf(examId);
  const answered = questions.filter((q) => q.correct !== null).length;
  const breakdown = exam.ended_at !== null ? topicBreakdown(questions) : [];
  return { ...exam, questions, answered, breakdown };
}

/* -------------------------------------------------------------------------- */
/* Sitting the paper                                                          */
/* -------------------------------------------------------------------------- */

export function answerMockQuestion(
  userId: string,
  examId: string,
  input: { questionId: string; correct: boolean; durationMs?: number },
): MockExam {
  const exam = requireExam(userId, examId);
  if (exam.ended_at !== null) throw badRequest('This mock is already finished.');

  const question = getDb()
    .prepare<[string, string, string], MockQuestionRow>(
      'SELECT * FROM mock_exam_questions WHERE id = ? AND exam_id = ? AND user_id = ?',
    )
    .get(input.questionId, examId, userId);
  if (!question) throw notFound('Question not found');

  return tx(() => {
    getDb()
      .prepare('UPDATE mock_exam_questions SET correct = ?, answered_at = ? WHERE id = ?')
      .run(input.correct ? 1 : 0, Date.now(), question.id);

    // A mock is real practice, so it feeds the scheduler the same way test mode
    // does: right is Good, wrong is Again. Only cards still exist to grade — an
    // AI-written question would carry no card_id.
    if (question.card_id && question.correct === null) {
      const card = getDb()
        .prepare<[string, string], { id: string }>('SELECT id FROM cards WHERE id = ? AND user_id = ?')
        .get(question.card_id, userId);
      if (card) {
        reviewCard(userId, card.id, {
          rating: input.correct ? 3 : 1,
          durationMs: input.durationMs,
          mode: 'test',
        });
      }
    }

    return getMockExam(userId, examId);
  });
}

/* -------------------------------------------------------------------------- */
/* Marking and feedback                                                       */
/* -------------------------------------------------------------------------- */

/** Group answered outcomes by topic. Unanswered questions count as missed — a
 *  blank on a real paper earns nothing. Cards with no topic gather under one
 *  "Untagged" line so the totals still add up. */
function topicBreakdown(questions: MockQuestionRow[]): TopicResult[] {
  const byTopic = new Map<string, { correct: number; total: number }>();
  for (const q of questions) {
    const key = q.topic?.trim() || 'Untagged';
    const bucket = byTopic.get(key) ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (q.correct === 1) bucket.correct += 1;
    byTopic.set(key, bucket);
  }
  return [...byTopic.entries()]
    .map(([topic, { correct, total }]) => ({
      topic,
      correct,
      total,
      pct: total > 0 ? Math.round((correct / total) * 100) : 0,
      confidence: null as number | null,
    }))
    .sort((a, b) => a.pct - b.pct);
}

/** A topic scored this well on the paper is worth about this much confidence:
 *  a clean sweep is "could teach it", a blank is "no idea". */
function pctToConfidence(pct: number): number {
  return Math.max(1, Math.min(5, Math.ceil(pct / 20)));
}

export function finishMockExam(userId: string, examId: string): MockExam {
  const exam = requireExam(userId, examId);
  const now = Date.now();

  return tx(() => {
    const questions = questionsOf(examId);
    const total = questions.length;
    const correct = questions.filter((q) => q.correct === 1).length;
    const score = total > 0 ? (correct / total) * 100 : 0;

    if (exam.ended_at === null) {
      getDb()
        .prepare('UPDATE mock_exams SET ended_at = ?, score_pct = ? WHERE id = ? AND user_id = ?')
        .run(now, score, examId, userId);
    }

    const breakdown = topicBreakdown(questions);

    // The part that matters: the paper re-rates the topic matrix. Where a card's
    // free-text topic matches a real topic row in the same subject (by name), the
    // score on that topic becomes a fresh self-rating, so what the student is told
    // to revise next reflects how the mock actually went.
    if (exam.subject_id) {
      for (const line of breakdown) {
        if (line.topic === 'Untagged') continue;
        const match = getDb()
          .prepare<[string, string, string], { id: string }>(
            `SELECT id FROM topics
              WHERE user_id = ? AND subject_id = ? AND name = ? COLLATE NOCASE
              LIMIT 1`,
          )
          .get(userId, exam.subject_id, line.topic);
        if (match) {
          const confidence = pctToConfidence(line.pct);
          rateTopic(userId, match.id, confidence, now);
          line.confidence = confidence;
        }
      }
    }

    const fresh = requireExam(userId, examId);
    return {
      ...fresh,
      questions,
      answered: questions.filter((q) => q.correct !== null).length,
      breakdown,
    };
  });
}

/** Recent papers, for a history strip on the mock screen. */
export function listMockExams(userId: string, limit = 10): MockExamRow[] {
  return getDb()
    .prepare<[string, number], MockExamRow>(
      'SELECT * FROM mock_exams WHERE user_id = ? ORDER BY started_at DESC LIMIT ?',
    )
    .all(userId, limit);
}
