/**
 * A drawn quantity that eases to its new value on a refresh instead of jumping
 * — a dial's arc and bead, a meter's fill — so a change is seen as a change.
 *
 * ⚠ Only the drawing moves. The printed figure beside it is always the value
 * itself: a number that counted up would show, on the way, figures no meter
 * ever reported. The first value is drawn where it is, without travel, and
 * under reduced motion every value is.
 */
import { useEffect } from "react";
import { useReducedMotion, useSpring, type MotionValue } from "framer-motion";

export function useEasedValue(target: number): MotionValue<number> {
  const reduce = useReducedMotion();
  const eased = useSpring(target, { stiffness: 90, damping: 20, restDelta: 0.0001 });
  useEffect(() => {
    if (reduce) eased.jump(target);
    else eased.set(target);
  }, [eased, target, reduce]);
  return eased;
}
