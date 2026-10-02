-- Database-level money guards. These hold even if application code is wrong:
--   1. wallets.balance changes only through ledger entries (and is never negative for
--      user/group wallets, via the CHECK in 0001);
--   2. every transaction's entries sum to zero at commit;
--   3. financial history and audit logs are append-only.

-- 1. Ledger entries move wallet balances. The UPDATE takes a row lock on the wallet,
--    which serializes concurrent spends from the same wallet.
CREATE FUNCTION lulu_apply_ledger_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_balance numeric(78, 0);
BEGIN
  UPDATE wallets SET balance = balance + NEW.amount
  WHERE id = NEW.wallet_id
  RETURNING balance INTO new_balance;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet % does not exist', NEW.wallet_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.balance_after := new_balance;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_apply
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION lulu_apply_ledger_entry();

CREATE FUNCTION lulu_guard_wallet_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance <> 0 THEN
      RAISE EXCEPTION 'wallets must be created with a zero balance' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2 THEN
    -- depth 1 = a direct UPDATE; depth 2 = the update issued by lulu_apply_ledger_entry
    RAISE EXCEPTION 'wallet balances change only through ledger entries' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallets_balance_guard
  BEFORE INSERT OR UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION lulu_guard_wallet_balance();

-- 2. Balanced transactions, checked at commit so a transaction can insert its entries
--    one by one.
CREATE FUNCTION lulu_check_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
BEGIN
  SELECT coalesce(sum(amount), 0) INTO total
  FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'transaction % is unbalanced: entries sum to %', NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lulu_check_transaction_balanced();

-- 3. Append-only history.
CREATE FUNCTION lulu_forbid_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; record a compensating entry instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION lulu_forbid_modification();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION lulu_forbid_modification();

CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION lulu_forbid_modification();
CREATE TRIGGER transactions_no_truncate
  BEFORE TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION lulu_forbid_modification();

CREATE TRIGGER interest_settlements_append_only
  BEFORE UPDATE OR DELETE ON interest_settlements
  FOR EACH ROW EXECUTE FUNCTION lulu_forbid_modification();

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION lulu_forbid_modification();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION lulu_forbid_modification();
