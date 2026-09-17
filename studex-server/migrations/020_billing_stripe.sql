-- What the payment processor knows this account as, and what it has already
-- told us.
--
-- 011 gave an entitlement a `source` and a `reference`, which was everything
-- needed to record a purchase that had already happened. Actually taking the
-- money needs two more things, and neither belongs on `users`.

-- The customer, so a renewal or a cancellation months later can be traced back
-- to an account. Stripe sends the customer id and nothing else on those
-- events: without this row, a subscription that lapses has no one to lapse.
CREATE TABLE billing_customers (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Stripe's `cus_…`. Unique both ways: one account, one customer.
  customer_id TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Every webhook event that has been acted on.
--
-- Stripe retries an event until it is acknowledged, and will send the same one
-- again after a timeout it decided on rather than one we did. Granting Pro
-- twice is harmless; a refund handler that runs twice is not. Making the id
-- the primary key turns "have I seen this?" into an insert that either works
-- or does not, inside the same transaction as the effect.
CREATE TABLE billing_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  received_at  INTEGER NOT NULL
);
