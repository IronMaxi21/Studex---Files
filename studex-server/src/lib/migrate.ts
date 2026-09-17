import { getDb, migrate } from './db.js';

const ran = migrate(getDb());
if (ran.length === 0) console.log('No pending migrations.');
else console.log(`Applied: ${ran.join(', ')}`);
