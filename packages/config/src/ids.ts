/** Stable identifiers shared by config, database, domain and texts. Never rename: they are stored. */

/** Ordered as in the owner's table: more common prey first. */
export const FOOD_KINDS = [
  'bone',
  'mouse',
  'chicken',
  'pig',
  'sheep',
  'cow',
  'deer',
  'human',
] as const;
export type FoodKind = (typeof FOOD_KINDS)[number];

/** Ordered by price. */
export const TOOL_KINDS = ['knife', 'axe', 'sword', 'bow', 'magic_wand'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const CURSE_KINDS = ['hunt_haste', 'lolo_echo'] as const;
export type CurseKind = (typeof CURSE_KINDS)[number];

/** Game time zone. Fixed by the owner; deliberately not an environment variable. */
export const GAME_TIME_ZONE = 'Asia/Tehran';

/** Probabilities and percentages are integers in basis points: 1 bp = 0.01 %. */
export const BP_SCALE = 10_000;

/** Money is stored in centi-points: 1 LuluPoint = 100 centi. */
export const CENTI_PER_POINT = 100n;
