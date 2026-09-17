import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as settings from '../domain/settings.js';
import { requireAuth } from '../lib/http.js';
import { parse } from '../lib/validation.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', async (req) => {
    const { user } = requireAuth(req);
    return { settings: settings.getAccountSettings(user.id) };
  });

  app.patch('/settings', async (req) => {
    const { user } = requireAuth(req);
    const body = parse(settings.accountSettingsSchema, req.body);
    return { settings: settings.updateAccountSettings(user.id, body) };
  });

  app.get('/settings/devices/:deviceId', async (req) => {
    const { user } = requireAuth(req);
    const { deviceId } = parse(z.object({ deviceId: settings.deviceIdSchema }), req.params);
    return { settings: settings.getDeviceSettings(user.id, deviceId) };
  });

  app.patch('/settings/devices/:deviceId', async (req) => {
    const { user } = requireAuth(req);
    const { deviceId } = parse(z.object({ deviceId: settings.deviceIdSchema }), req.params);
    const body = parse(settings.deviceSettingsSchema, req.body);
    return { settings: settings.updateDeviceSettings(user.id, deviceId, body) };
  });
}
