import { CENTI_PER_POINT } from '@lulu/config';

/** Whole LuluPoints → centi-points. */
export function pointsToCenti(points: number | bigint): bigint {
  if (typeof points === 'number' && !Number.isSafeInteger(points)) {
    throw new RangeError(`not a whole number of points: ${points}`);
  }
  return BigInt(points) * CENTI_PER_POINT;
}

/** Centi-points → whole LuluPoints, rounded down. */
export function centiToWholePoints(centi: bigint): bigint {
  return centi / CENTI_PER_POINT;
}

/** ceil(numerator / denominator) for non-negative integers. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
