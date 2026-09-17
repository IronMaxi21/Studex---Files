/**
 * The two things "due" can mean, kept apart on purpose.
 *
 * A card that has never been studied is waiting for you, but it is not waiting
 * to be *reviewed* — there is nothing yet to review. The screens use both
 * senses, and which one is right depends on whether the number stands alone:
 *
 *  - The Home and Statistics tiles say "cards due" with nothing beside them, so
 *    they mean everything waiting, new cards included. Same for the "· N due"
 *    on a deck card in the library.
 *  - The deck page and the Flashcards header put DUE next to NEW as separate
 *    columns, so there a new card must land in exactly one of them.
 *
 * Both predicates were written out by hand across four queries and had drifted:
 * the deck page counted a single unseen card as due *and* new, and offered to
 * study two cards when there was one. Naming the difference is what stops that
 * happening again.
 *
 * `alias` is the table alias in the surrounding query, when it has one. Each
 * fragment ends with a `?` placeholder for the current time, so callers pass
 * `now` at that position. Nothing here comes from a request.
 */

/** Ready to be reviewed: seen before, and its interval has elapsed. */
export function dueForReview(alias = ''): string {
  const c = alias ? `${alias}.` : '';
  return `${c}suspended = 0 AND ${c}state != 'new' AND ${c}due_at <= ?`;
}

/** Everything waiting for attention, whether or not it has been seen. */
export function waitingNow(alias = ''): string {
  const c = alias ? `${alias}.` : '';
  return `${c}suspended = 0 AND ${c}due_at <= ?`;
}

/**
 * A card only counts while the deck it belongs to is still in the library.
 *
 * Trashing a deck used to leave its cards in the review queue and in every
 * total that counted them, so a deck could be thrown away and still ask to be
 * studied. The predicate is a correlated EXISTS rather than a join so it can be
 * dropped into a counting query without changing its shape.
 */
export function inLiveDeck(alias = ''): string {
  const c = alias ? `${alias}.` : '';
  return `EXISTS (SELECT 1 FROM files df WHERE df.id = ${c}deck_id AND df.trashed_at IS NULL)`;
}
