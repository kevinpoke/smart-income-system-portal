"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useSpring, useTransform } from "framer-motion";
import { formatCurrency } from "@/lib/mockData";

/**
 * Smoothly tweens toward `value` (a number) instead of snapping, giving the
 * "ticking" number animation the spec calls for. Renders as currency by
 * default; pass format="raw" for a plain number.
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

  const text =
    format === "currency"
      ? formatCurrency(display)
      : display.toFixed(decimals);

  return <motion.span className={className}>{text}</motion.span>;
}
