-- Implicit misunderstanding signals (migration 018). One row per piece of
-- FREE accuracy evidence the trader hands us without being asked:
--   rephrase          — a second question within seconds of an ANSWERED turn
--   ticket_abandoned  — we prepared an order ticket and they cancelled it
--   draft_dismissed   — same for the editable order draft
--   negative_feedback — a thumbs-down, joined to the intent we classified
-- None of it is labeled truth: it is evidence that the classifier may have
-- misread the trader, and the export route turns it into eval rows a human
-- then labels.
--
-- PRIVACY. `original_text` is real trader text and is NULLABLE ON PURPOSE: a
-- user who turned auto-learning off (users_memory.learn_opt_out, migration
-- 012) has their text dropped at the recorder — the row still counts, the
-- words are not ours to keep. Text is bounded to 280 chars at write time and
-- exists for these four signals only. Rows are keyed by the session's
-- EFFECTIVE user key (`id:<username_lower>` when an in-panel identity is
-- active, else the host-minted sub / anonymous session id), like memory,
-- alerts and uploads.
CREATE TABLE IF NOT EXISTS intent_signals (
  id                text             PRIMARY KEY,
  partner_id        text             NOT NULL,
  user_key          text             NOT NULL,
  session_id        text,
  signal            text             NOT NULL CHECK (signal IN ('rephrase', 'ticket_abandoned', 'draft_dismissed', 'negative_feedback')),
  original_text     text,            -- NULL when the user opted out of learning
  classified_intent text,            -- what we THOUGHT they wanted
  confidence        double precision,
  detail            jsonb,
  created_at        bigint           NOT NULL
);

-- The operator read: recent signals for one partner, newest first.
CREATE INDEX IF NOT EXISTS intent_signals_partner_created_idx
  ON intent_signals (partner_id, created_at DESC);

-- "Which intents do we misread most?" — the summary + the eval-promotion view.
CREATE INDEX IF NOT EXISTS intent_signals_intent_signal_idx
  ON intent_signals (classified_intent, signal);
