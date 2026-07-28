"use client";

import { useEffect, useState } from "react";
import { motion, useSpring } from "framer-motion";
import { formatCurrency, formatCurrency5, formatCurrencyTrimmed } from "@/lib/mockData";

/**
 * Smoothly tweens toward `value` (a number) instead of snapping, giving the
 * "ticking" number animation the spec calls for. Renders as currency by
 * default; pass format="currency5" for the always-5-decimal Live Earnings
 * ticker, format="currencyTrimmed" for the Dashboard summary cards / per-Node
 * Total Earnings column (up to 5 decimals, trailing zeros trimmed back to a
 * minimum of 2 -- see lib/mockData.js formatCurrencyTrimmed), or
 * format="raw" for a plain number.
 */
export default function AnimatedNumber({
  value,
  format = "currency",
  className = "",
  decimals = 2,
}) {
  const spring = useSpring(value, { stiffness: 120, damping: 20, mass: 0.5 });
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    spring.set(value);
  }, [value, spring]);

  useEffect(() => {
    const unsub = spring.on("change", (v) => setDisplay(v));
    return unsub;
  }, [spring]);

  let text;
  if (format === "currency") {
    text = formatCurrency(display);
  } else if (format === "currency5") {
    text = formatCurrency5(display);
  } else if (format === "currencyTrimmed") {
    text = formatCurrencyTrimmed(display);
  } else {
    text = display.toFixed(decimals);
  }

  return <motion.span className={className}>{text}</motion.span>;
}
