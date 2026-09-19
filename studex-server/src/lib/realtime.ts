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

    /**
     * This subscription is over — for any reason, once.
     *
     * Everything below hangs off this flag, and it is the whole reason this
     * file has a state machine in it at all. A channel does not report a lost
     * connection once: supabase-js keeps trying to rejoin on its own, and every
     * attempt that fails calls this status callback again. Worse, tearing the
     * channel down is itself reported as `CLOSED`, so the obvious shape —
     * report the drop, and have the supervisor close the handle — is a loop
     * that feeds itself. It did exactly that: thousands of identical
     * "library subscription dropped" lines in the same millisecond, a websocket
     * client leaked on each pass, and a backend that eventually stopped
     * answering. A drop is one event, the first one, and after it this handle
     * says nothing more.
     */
    let finished = false;

    /**
     * Lets go of the socket and the client behind it.
     *
     * Both halves matter: removing the channel stops the rejoin timer, and
     * disconnecting releases the websocket. Leaving the client alive means one
     * more socket quietly retrying forever for every drop of the day.
     */
    const teardown = async (): Promise<void> => {
      try {
        await sb.removeChannel(channel);
      } catch {
        // Already gone, or gone in the middle of going. Either way there is
        // nothing left to release and nothing useful to say about it.
      }
      try {
        await sb.realtime.disconnect();
      } catch {
        // As above.
      }
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          if (!settled) { settled = true; resolve(); }
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          const reason = err?.message ?? status;
          if (!settled) { settled = true; finished = true; void teardown(); reject(new Error(reason)); return; }
          if (finished) return;
          finished = true;
          // Torn down before the supervisor hears about it, so that by the time
          // it decides to reopen there is nothing of this attempt left running.
          void teardown();
          onDropped(reason);
        }
      });
    });

    return {
      setToken(token) {
        if (finished) return;
        sb.realtime.setAuth(token);
      },
      async close() {
        if (finished) return;
        finished = true;
        await teardown();
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
