import { config } from '../lib/config.js';

/**
 * What this build of Studex offers, in one place.
 *
 * The app people download and the builds we run on our own machines are the
 * same code with two different jobs. Ours is a workbench: it names the models
 * behind each feature, logs every call, takes a key of its own, switches the
 * shell between three layouts and can be pointed at unfinished releases. The
 * one that ships is a product, and a product has one shape — the shape it was
 * designed with. Everything that changes the shape of the app rather than
 * doing something with a library belongs to the workbench.
 *
 * Answering it here, rather than in each screen, means the release build's
 * limits are a short list that can be read in one sitting, and that the server
 * enforces the same list the UI draws — hiding a control is a courtesy, not a
 * restriction, because whatever hides it is the part anyone can edit.
 */
export interface Capabilities {
  /** `dev` or `release`, as the shell stamped it. */
  channel: 'dev' | 'release';
  /**
   * The screens that exist to debug the build: the model roster behind each
   * AI feature, and the log of every call with its tokens and timing.
   */
  developer: boolean;
  /**
   * Whether the app's shape can be changed — which shell the window uses, and
   * which set of tools a canvas carries. The release build is fixed to the
   * layout the product was designed around; everything people actually read
   * with (theme, accent, density, page width, type size, reading font) stays,
   * because that is personalisation rather than a different app.
   */
  layoutChoice: boolean;
  /** Whether this build may be pointed at releases that are not finished. */
  betaChannel: boolean;
}

/** The layout a release build is fixed to: the one the product is designed around. */
export const USER_SHELL = 'folder_tree';
export const USER_CANVAS_CHROME = 'floating_dock';

export function capabilities(): Capabilities {
  const dev = !config.isRelease;
  return {
    channel: config.isRelease ? 'release' : 'dev',
    developer: dev,
    layoutChoice: dev,
    betaChannel: dev,
  };
}

/** Shorthand for the many places that only need to know one answer. */
export function may(name: keyof Omit<Capabilities, 'channel'>): boolean {
  return capabilities()[name];
}
