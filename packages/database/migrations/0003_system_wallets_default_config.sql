-- 1. System (mint/burn/adjust) wallets no longer keep a running balance.
--    Every reward and every purchase in the game touches one of them; updating their
--    row would make all players' actions queue on a single row lock. Their totals are
--    the sum of their ledger entries instead. User and group wallets are unchanged:
--    still row-locked, still never negative.
ALTER TABLE ledger_entries ALTER COLUMN balance_after DROP NOT NULL;
ALTER TABLE ledger_entries ALTER COLUMN balance_after DROP DEFAULT;

CREATE OR REPLACE FUNCTION lulu_apply_ledger_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  wallet_kind text;
  new_balance numeric(78, 0);
BEGIN
  SELECT kind INTO wallet_kind FROM wallets WHERE id = NEW.wallet_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet % does not exist', NEW.wallet_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF wallet_kind = 'system' THEN
    NEW.balance_after := NULL;
    RETURN NEW;
  END IF;

  UPDATE wallets SET balance = balance + NEW.amount
  WHERE id = NEW.wallet_id
  RETURNING balance INTO new_balance;
  NEW.balance_after := new_balance;
  RETURN NEW;
END;
$$;

-- Non-system entries always carry the resulting balance.
CREATE FUNCTION lulu_check_balance_after() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance_after IS NULL AND (SELECT kind FROM wallets WHERE id = NEW.wallet_id) <> 'system' THEN
    RAISE EXCEPTION 'ledger entry for a user/group wallet lacks balance_after' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_entries_balance_after_present
  AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION lulu_check_balance_after();

-- 2. The code-defined default configuration is stored at most once, so seeding it is
--    repeatable and race-free (INSERT … ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX config_versions_single_default ON config_versions ((true)) WHERE source = 'default';
