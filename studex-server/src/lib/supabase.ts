import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthError } from '@supabase/supabase-js';
import { config } from './config.js';
import { conflict, forbidden, tooManyRequests, unauthorized, ApiError } from './errors.js';

/** A Supabase account, reduced to the three things Studex stores about it. */
export interface SupabaseIdentity {
  /** The Supabase user uuid. Stable across email changes; the linking key. */
  id: string;
  email: string;
  displayName: string | null;
}

/**
 * The tokens a Supabase sign-in mints. Studex authorises its own requests with
 * its own cookie, but every RLS policy upstream is written against auth.uid(),
 * so acting on the user's behalf there means holding and replaying these.
 */
export interface SupabaseSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface SignUpOutcome {
  /**
   * The new identity, or null when Supabase accepted the signup but withheld a
   * session pending email confirmation. There is no local account until an
   * identity exists, because there is nothing yet proving the address is theirs.
   */
  identity: SupabaseIdentity | null;
  /** False when a confirmation email was sent and sign-in cannot proceed yet. */
  confirmed: boolean;
  /** Present only alongside an identity. */
  session: SupabaseSession | null;
}

export interface SignInOutcome {
  identity: SupabaseIdentity;
  session: SupabaseSession | null;
}

/**
 * The surface Studex needs from an identity provider. Narrow on purpose: it is
 * the seam the tests substitute, so no test has to reach the network to
 * exercise account linking, confirmation handling or error mapping.
 */
export interface AuthGateway {
  signUp(input: { email: string; password: string; displayName: string }): Promise<SignUpOutcome>;
  signIn(input: { email: string; password: string }): Promise<SignInOutcome>;
  /** Returns the session the change left behind, so it can replace the stored one. */
  changePassword(input: {
    email: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<SupabaseSession | null>;
}

/**
 * A client per operation.
 *
 * supabase-js caches the signed-in session on the instance, and this server
 * handles every account through one process — a long-lived shared client would
 * hold one user's tokens while serving the next. Constructing a client is just
 * config and a fetch wrapper, so the safe thing is also the cheap one.
 */
function client(): SupabaseClient {
  const settings = config.supabase;
  if (!settings) throw new Error('Supabase is not configured');
  return createClient(settings.url, settings.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function isAuthError(error: unknown): error is AuthError {
  return typeof error === 'object' && error !== null && 'message' in error;
}

/**
 * Supabase's failures, restated in Studex's vocabulary.
 *
 * Sign-in failures collapse to one message on purpose: the local provider
 * answers unknown-address and wrong-password identically, and this path must
 * not be the one that tells them apart.
 */
export function translate(error: unknown, context: 'sign-in' | 'sign-up'): ApiError {
  if (!isAuthError(error)) {
    return new ApiError(502, 'identity_provider_unavailable', 'Cannot reach the sign-in service.');
  }

  const code = error.code ?? '';
  const status = error.status ?? 0;

  if (code === 'email_not_confirmed') {
    return forbidden('Confirm your email address before signing in.');
  }
  // Order matters here, and getting it wrong is not cosmetic. Supabase answers
  // several unrelated refusals with 422 — a password its policy rejects is one
  // of them — so testing the status before the code told everyone whose
  // password was refused that their address was already registered. Codes are
  // specific; the status is not. Read the specific thing first.
  if (code === 'weak_password') {
    return forbidden(error.message || 'That password is too weak');
  }
  if (code === 'user_already_exists' || code === 'email_exists') {
    if (context === 'sign-up') return conflict('That email address is already registered');
  }
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || status === 429) {
    return tooManyRequests('Too many attempts. Wait a few minutes and try again.');
  }
  if (status === 422) {
    // Some other refusal: an address the project will not accept, a validation
    // rule of its own. Supabase's wording is worth more than a guess at which,
    // and 403 is the status this client already shows verbatim.
    return context === 'sign-up'
      ? forbidden(error.message || 'Could not create that account')
      : unauthorized('Incorrect email or password');
  }
  if (status === 400 || status === 401) {
    return context === 'sign-up'
      ? forbidden(error.message || 'Could not create that account')
      : unauthorized('Incorrect email or password');
  }
  // Anything else is the provider misbehaving, not the caller getting it wrong.
  return new ApiError(502, 'identity_provider_unavailable', 'The sign-in service is unavailable.');
}

interface RawUser {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: unknown[] | null;
}

function toIdentity(user: RawUser, fallbackEmail: string): SupabaseIdentity {
  const name = user.user_metadata?.['display_name'];
  return {
    id: user.id,
    email: user.email ?? fallbackEmail,
    displayName: typeof name === 'string' && name.trim() !== '' ? name.trim() : null,
  };
}

interface RawSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number | null;
}

function toSession(raw: RawSession | null | undefined): SupabaseSession | null {
  if (!raw?.access_token || !raw.refresh_token) return null;
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    // expires_at arrives in seconds; everything else in this codebase is ms.
    expiresAt: raw.expires_at ? raw.expires_at * 1000 : Date.now() + 55 * 60 * 1000,
  };
}

/**
 * A client acting as one particular user, for anything the Supabase project
 * protects with row-level security.
 *
 * setSession refreshes on its own when the access token has expired, and the
 * refreshed pair is handed back rather than swallowed: refresh tokens rotate,
 * so a caller that stored the old one has to replace it or the next call fails.
 * Returns null when the session is past saving and the user must sign in again.
 */
export async function clientForSession(
  session: SupabaseSession,
): Promise<{ client: SupabaseClient; session: SupabaseSession } | null> {
  const sb = client();
  const { data, error } = await sb.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });
  if (error) return null;
  const refreshed = toSession(data.session as RawSession | null);
  if (!refreshed) return null;
  return { client: sb, session: refreshed };
}

export const supabaseGateway: AuthGateway = {
  async signUp({ email, password, displayName }) {
    const sb = client();
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });
    if (error) throw translate(error, 'sign-up');

    const user = data.user as RawUser | null;

    // With email confirmation enabled, Supabase answers a signup for an
    // address that already exists with a decoy user carrying no identities,
    // rather than admitting the address is taken. Treating that as "check your
    // email" keeps Studex from becoming the oracle Supabase declined to be.
    if (user && Array.isArray(user.identities) && user.identities.length === 0) {
      return { identity: null, confirmed: false, session: null };
    }

    if (!data.session || !user) return { identity: null, confirmed: false, session: null };

    return {
      identity: toIdentity(user, email),
      confirmed: true,
      session: toSession(data.session as RawSession),
    };
  },

  async signIn({ email, password }) {
    const sb = client();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw translate(error, 'sign-in');
    if (!data.user) throw unauthorized('Incorrect email or password');
    return {
      identity: toIdentity(data.user as RawUser, email),
      session: toSession(data.session as RawSession | null),
    };
  },

  async changePassword({ email, currentPassword, newPassword }) {
    const sb = client();
    // Proving the current password is the point of the step, and Supabase's
    // updateUser does not ask for it — so it is proved by signing in.
    const { error: signInError } = await sb.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (signInError) throw unauthorized('Current password is incorrect');

    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw translate(error, 'sign-up');

    // Changing the password can invalidate sessions minted before it. Handing
    // the resulting one back lets the caller replace what it had stored, so
    // background work does not start failing silently after a rotation.
    const { data } = await sb.auth.getSession();
    return toSession(data.session as RawSession | null);
  },
};
