/**
 * The value, once it has stopped changing for `delayMs`.
 *
 * For input that drives a fetch: every keystroke of a Plant search would
 * otherwise switch the Plant on screen and fire that Plant's dozen queries,
 * only for the next keystroke to throw them away.
 */

import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
