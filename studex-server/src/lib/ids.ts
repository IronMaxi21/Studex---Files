import { randomUUID } from 'node:crypto';

/** Opaque, unguessable identifier for every user-visible entity. */
export const newId = (): string => randomUUID();
