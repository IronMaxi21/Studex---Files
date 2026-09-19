import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { isValidTimeZone } from '../lib/time.js';
import { AUTO_SYNC_CHOICES, isAutoSyncChoice } from './autosync.js';
import { may, USER_CANVAS_CHROME, USER_SHELL } from './capabilities.js';

/** "Theme and accent follow your account everywhere." */
export const accountSettingsSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']).optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Accent must be a 6-digit hex colour').optional(),
    dailyNewCards: z.number().int().min(0).max(1000).optional(),
    dailyReviewLimit: z.number().int().min(0).max(10_000).optional(),
    /**
     * The recall probability the FSRS scheduler aims for. Bounded to the same
     * 0.70..0.99 range intervalForRetention clamps to, so a client cannot ask
     * for a target the maths cannot honour.
     */
    retentionTarget: z.number().min(0.7).max(0.99).optional(),
    timezone: z.string().max(64).optional(),
    /**
     * How often the server syncs this account on its own, in minutes; 0 is
     * off. Constrained to the offered intervals rather than to a range, so a
     * client cannot ask for a sync every minute.
     */
    autoSyncMinutes: z
      .number()
      .int()
      .refine(isAutoSyncChoice, {
        message: `Automatic sync must be one of ${AUTO_SYNC_CHOICES.join(', ')} minutes`,
      })
      .optional(),
    /** Minutes of study the student means to do each week; 0 sets no goal. */
    weeklyGoalMinutes: z.number().int().min(0).max(6000).optional(),
    /** Whether earned streak freezes may cover a missed day. */
    streakFreeze: z.boolean().optional(),
    notifications: z
      .object({
        due_cards: z.boolean().optional(),
        exam_reminders: z.boolean().optional(),
        daily_summary: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

/** "Layout choices are per-device." */
export const deviceSettingsSchema = z
  .object({
    shellLayout: z.enum(['folder_tree', 'icon_rail', 'workspace_tabs']).optional(),
    canvasChrome: z.enum(['floating_dock', 'tool_column']).optional(),
    canvasGrid: z.enum(['dots', 'lines', 'plain', 'squares']).optional(),
    density: z.enum(['compact', 'comfortable']).optional(),
    /** How wide a document's column is, and how large it is set. */
    docWidth: z.enum(['narrow', 'regular', 'wide']).optional(),
    docTypeSize: z.enum(['small', 'regular', 'large']).optional(),
    /**
     * The reading typeface and its line spacing, applied to the document column
     * and the flashcard face. 'system' keeps the default document font;
     * 'dyslexic' selects OpenDyslexic where the face is available.
     */
    docFont: z.enum(['system', 'serif', 'sans', 'mono', 'dyslexic']).optional(),
    lineSpacing: z.enum(['tight', 'normal', 'relaxed', 'loose']).optional(),
    showMinimap: z.boolean().optional(),
    focusMode: z.boolean().optional(),
    reduceMotion: z.boolean().optional(),
    /** Whether this device copies titles and text into Spotlight. */
    spotlight: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

/** Device ids are client-generated, so their shape is constrained here. */
export const deviceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Device id must be 8-64 url-safe characters');

export function getAccountSettings(userId: string) {
  const row = getDb()
    .prepare<[string], Record<string, unknown>>('SELECT * FROM user_settings WHERE user_id = ?')
    .get(userId);
  if (!row) {
    const now = Date.now();
    getDb().prepare('INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)').run(userId, now);
    return getAccountSettings(userId);
  }
  return { ...row, notifications: JSON.parse(String(row.notifications ?? '{}')) };
}

export function updateAccountSettings(
  userId: string,
  patch: z.infer<typeof accountSettingsSchema>,
) {
  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) {
    throw badRequest('Unknown timezone');
  }

  getAccountSettings(userId); // ensures the row exists
  const now = Date.now();

  getDb()
    .prepare(
      `UPDATE user_settings SET
         theme = COALESCE(?, theme),
         accent = COALESCE(?, accent),
         daily_new_cards = COALESCE(?, daily_new_cards),
         daily_review_limit = COALESCE(?, daily_review_limit),
         retention_target = COALESCE(?, retention_target),
         timezone = COALESCE(?, timezone),
         auto_sync_minutes = COALESCE(?, auto_sync_minutes),
         notifications = COALESCE(?, notifications),
         weekly_goal_minutes = COALESCE(?, weekly_goal_minutes),
         streak_freeze = COALESCE(?, streak_freeze),
         updated_at = ?
       WHERE user_id = ?`,
    )
    .run(
      patch.theme ?? null,
      patch.accent ?? null,
      patch.dailyNewCards ?? null,
      patch.dailyReviewLimit ?? null,
      patch.retentionTarget ?? null,
      patch.timezone ?? null,
      patch.autoSyncMinutes ?? null,
      patch.notifications ? JSON.stringify(patch.notifications) : null,
      patch.weeklyGoalMinutes ?? null,
      patch.streakFreeze === undefined ? null : patch.streakFreeze ? 1 : 0,
      now,
      userId,
    );

  return getAccountSettings(userId);
}

export function getDeviceSettings(userId: string, deviceId: string) {
  const row = getDb()
    .prepare<[string, string], Record<string, unknown>>(
      'SELECT * FROM device_settings WHERE user_id = ? AND device_id = ?',
    )
    .get(userId, deviceId);

  if (!row) {
    const now = Date.now();
    getDb()
      .prepare('INSERT INTO device_settings (user_id, device_id, updated_at) VALUES (?, ?, ?)')
      .run(userId, deviceId, now);
    return getDeviceSettings(userId, deviceId);
  }

  return {
    ...row,
    // A build that may not change the app's shape is told the shape it has,
    // whatever is in its row. Rows outlive builds: a machine that ran a
    // developer build on this account once must not come back to a release
    // build still wearing a layout that build no longer offers.
    ...(may('layoutChoice') ? {} : { shell_layout: USER_SHELL, canvas_chrome: USER_CANVAS_CHROME }),
    show_minimap: row.show_minimap === 1,
    focus_mode: row.focus_mode === 1,
    reduce_motion: row.reduce_motion === 1,
    spotlight: row.spotlight === 1,
  };
}

export function updateDeviceSettings(
  userId: string,
  deviceId: string,
  patch: z.infer<typeof deviceSettingsSchema>,
) {
  getDeviceSettings(userId, deviceId); // ensures the row exists
  const now = Date.now();

  // Enforced here rather than left to the screen that draws the controls: the
  // UI is the part anyone can edit, so hiding a control only tidies the app.
  if (!may('layoutChoice')) {
    patch = { ...patch, shellLayout: undefined, canvasChrome: undefined };
  }

  getDb()
    .prepare(
      `UPDATE device_settings SET
         shell_layout = COALESCE(?, shell_layout),
         canvas_chrome = COALESCE(?, canvas_chrome),
         canvas_grid = COALESCE(?, canvas_grid),
         density = COALESCE(?, density),
         doc_width = COALESCE(?, doc_width),
         doc_type_size = COALESCE(?, doc_type_size),
         doc_font = COALESCE(?, doc_font),
         line_spacing = COALESCE(?, line_spacing),
         show_minimap = COALESCE(?, show_minimap),
         focus_mode = COALESCE(?, focus_mode),
         reduce_motion = COALESCE(?, reduce_motion),
         spotlight = COALESCE(?, spotlight),
         updated_at = ?
       WHERE user_id = ? AND device_id = ?`,
    )
    .run(
      patch.shellLayout ?? null,
      patch.canvasChrome ?? null,
      patch.canvasGrid ?? null,
      patch.density ?? null,
      patch.docWidth ?? null,
      patch.docTypeSize ?? null,
      patch.docFont ?? null,
      patch.lineSpacing ?? null,
      patch.showMinimap === undefined ? null : patch.showMinimap ? 1 : 0,
      patch.focusMode === undefined ? null : patch.focusMode ? 1 : 0,
      patch.reduceMotion === undefined ? null : patch.reduceMotion ? 1 : 0,
      patch.spotlight === undefined ? null : patch.spotlight ? 1 : 0,
      now,
      userId,
      deviceId,
    );

  return getDeviceSettings(userId, deviceId);
}
