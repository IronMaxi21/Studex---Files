import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

/**
 * The websocket half of sync.
 *
 * The interval in `domain/autosync.ts` answers "have my two Macs converged by
 * the time I open the second one?". This answers the other question, the one
 * an interval cannot: a change made on the iPad appearing on the Mac that is
 * open in front of you, without a fifteen-minute wait and without a button.
 *
 * Everything here is the transport and nothing else. What to do about a change
 * — coalescing a burst, refusing to sync twice in a second, backing off a
 * project that keeps dropping the socket — is `domain/realtime.ts`'s to decide,
 * because that is the part worth testing and a websocket is not.
 */

/** A live subscription, and the two things its owner ever needs to do to it. */
export interface WatchHandle {
  /**
   * Replaces the credential the socket is authenticated with.
   *
   * Access tokens last an hour and row-level security is evaluated against the
   * one the socket presented, so a connection that is never re-authorised stops
   * delivering rows after an hour — silently, because from the client's side a
   * table with nothing to say and a table it may no longer read look identical.
   */
  setToken(accessToken: string): void;
  close(): Promise<void>;
}

export interface WatchRequest {
  /** The Supabase uuid, which is what `library_items.user_id` holds. */
  supabaseUserId: string;
  accessToken: string;
  /** A row this account owns was inserted, updated or deleted. */
  onChange(): void;
  /** The subscription is no longer live and will not recover on its own. */
  onDropped(reason: string): void;
}

export interface LibraryWatcher {
  watch(request: WatchRequest): Promise<WatchHandle>;
}

/**
 * The real one.
 *
 * A client per watched account rather than one shared client: realtime
 * authorises the *socket*, so two accounts on one connection would have to
 * share a token, and there is no token that speaks for both. On the machine
 * this runs on there is normally exactly one signed-in account anyway.
 */
export const supabaseWatcher: LibraryWatcher = {
  async watch({ supabaseUserId, accessToken, onChange, onDropped }) {
    if (!config.supabase) throw new Error('no Supabase project is configured');

    const sb: SupabaseClient = createClient(config.supabase.url, config.supabase.anonKey, {
      // This client exists for one socket. It must not persist a session, and
      // must not refresh one behind the supervisor's back: the supervisor holds
      // the stored tokens and is the only thing allowed to rotate them.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      // A library does not change ten times a second, and the ceiling is what
      // stops a bulk import upstream from arriving as a thousand callbacks.
      realtime: { params: { eventsPerSecond: 2 } },
    });

    sb.realtime.setAuth(accessToken);

    const channel: RealtimeChannel = sb
      .channel(`studex:library:${supabaseUserId}`, { config: { private: false } })
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'library_items',
          // Server-side, so another account's writes never reach this socket at
          // all. Row-level security would refuse them anyway; this means they
          // are not sent.
          filter: `user_id=eq.${supabaseUserId}`,
        },
        () => onChange(),
      );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          if (!settled) { settled = true; resolve(); }
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          const reason = err?.message ?? status;
          if (!settled) { settled = true; reject(new Error(reason)); return; }
          onDropped(reason);
        }
      });
    });

    return {
      setToken(token) {
        sb.realtime.setAuth(token);
      },
      async close() {
        await sb.removeChannel(channel);
        void sb.realtime.disconnect();
      },
    };
  },
};

/**
 * What the supervisor actually calls. Substituted in tests, which is the only
 * way any of the logic around this is exercisable without a Supabase project
 * and a network.
 */
let watcher: LibraryWatcher = supabaseWatcher;

export function libraryWatcher(): LibraryWatcher {
  return watcher;
}

export function setLibraryWatcher(next: LibraryWatcher): void {
  watcher = next;
}

export function resetLibraryWatcher(): void {
  watcher = supabaseWatcher;
}
