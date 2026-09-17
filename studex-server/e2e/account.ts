import path from 'node:path';
import url from 'node:url';

/**
 * The one account the whole suite signs in as.
 *
 * The database is thrown away when the test server boots, so this is always
 * the first account on a fresh instance — which is also the only way in: the
 * sign-in screen offers a create form precisely because nobody has registered.
 */
export const ACCOUNT = {
  name: 'Aisha Test',
  email: 'e2e@studex.test',
  // Long enough for the sign-up form's own minimum, which is stricter than
  // most: twelve characters.
  password: 'revision-season-2026',
};

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** Where the signed-in cookie jar is kept between the setup project and the tests. */
export const STORAGE_STATE = path.join(here, '.auth', 'state.json');
