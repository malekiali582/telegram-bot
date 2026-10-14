-- Admin panel, step 8.6: the ghost-content page warns when one of the next N Tehran days
-- has no batch waiting. N is a suggested monitoring value; it never changes the game.
UPDATE config_versions
   SET config = jsonb_set(config, '{monitoring,ghostLookaheadDays}', '3')
 WHERE config ? 'monitoring' AND NOT config -> 'monitoring' ? 'ghostLookaheadDays';
