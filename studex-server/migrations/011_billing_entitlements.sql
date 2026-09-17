-- What an account is entitled to, and where that entitlement came from.
--
-- The plan on `users` is the tier the app behaves as; a row here is the reason
-- it is allowed to. Keeping them apart is what makes an upgrade something that
-- has to be granted rather than something the client can ask for: setPlan
-- refuses to raise a tier with no matching row, so the only way up is through
-- whatever writes one.
CREATE TABLE billing_entitlements (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan        TEXT NOT NULL CHECK (plan IN ('pro')),
  -- Where it came from: a completed checkout, or a licence granted by whoever
  -- runs this install. Never written by a request from the app.
  source      TEXT NOT NULL CHECK (source IN ('purchase','licence')),
  -- An external payment reference, when there is one.
  reference   TEXT,
  granted_at  INTEGER NOT NULL,
  -- NULL means it does not lapse.
  expires_at  INTEGER
);

-- Accounts already on Pro when this rule arrived were legitimately on Pro: the
-- rule is new, not retroactive. Without this backfill, the first time such an
-- account touched its plan it would drop to Free and have no way back up.
INSERT INTO billing_entitlements (user_id, plan, source, reference, granted_at, expires_at)
SELECT id, 'pro', 'licence', 'pre-existing', CAST(strftime('%s','now') AS INTEGER) * 1000, NULL
FROM users
WHERE plan = 'pro';
