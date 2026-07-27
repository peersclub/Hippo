-- Phase C: the trader's per-user auto-learning opt-OUT flag. The model is
-- opt-OUT: learning is ON by default for entitled partners, and this column
-- records the choice to turn it off. Distinct from persona.optIn (the
-- structured-persona consent) — a trader can keep persona memory yet stop
-- auto-learning, or vice versa.
--
-- ALTER TABLE (never db push): the local dev DB lacks the `vector` extension a
-- full schema sync would try to create. NOT NULL DEFAULT false = existing rows
-- (and unseen users) stay opted IN, preserving the opt-out contract.
ALTER TABLE users_memory ADD COLUMN IF NOT EXISTS learn_opt_out boolean NOT NULL DEFAULT false;
