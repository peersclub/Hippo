-- Self-provisioned partners land as 'sandbox' (hippo register) until an
-- operator activates them in the admin panel.
ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_status_check;
ALTER TABLE partners
  ADD CONSTRAINT partners_status_check CHECK (status IN ('active', 'suspended', 'sandbox'));
