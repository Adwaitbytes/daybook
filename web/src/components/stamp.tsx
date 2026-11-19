"use client";

import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useId } from "react";

type Props = {
  /** Centre word: "Paid" on a settled invoice, "Part paid" for the smaller variant. */
  word: string;
  /** Text around the ring, e.g. "PAID IN FULL / INVOICE 4 / 19 NOV 2026". */
  ring: string;
  /** Width class for the wrapper; the seal scales to it. */
  className?: string;
  /** Fall and land on mount. Off for print and for reduced motion. */
  land?: boolean;
  label: string;
  /** Seconds before it lands, so it can follow the ledger lines being written in. */
  delay?: number;
};

/**
 * The ring seal: B's geometry in A's red, with a light ink texture that only nicks the edges. It is the one
 * place Daybook uses Motion: a short fall and impact, no bounce, because rubber stamps do not bounce.
 */
export function Stamp({ word, ring, className = "w-[148px]", land = true, label, delay = 0.35 }: Props) {
  const reduce = useReducedMotion();
  const id = useId().replaceAll(":", "");
  const animate = land && reduce !== true;
  const seal = (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 148 148"
      role="img"
      aria-label={label}
      style={{ color: "var(--stamp)" }}
    >
      <defs>
        <path id={`${id}-ring`} d="M74 74 m-52 0 a52 52 0 1 1 104 0 a52 52 0 1 1 -104 0" />
        <filter id={`${id}-grain`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="n" />
          <feColorMatrix in="n" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -3 0 0 0 2.6" result="m" />
          <feComposite in="SourceGraphic" in2="m" operator="in" />
        </filter>
      </defs>
      <g filter={`url(#${id}-grain)`} fill="none" stroke="currentColor">
        <circle cx="74" cy="74" r="70" strokeWidth="4" />
        <circle cx="74" cy="74" r="64" strokeWidth="1.5" />
        <circle cx="74" cy="74" r="40" strokeWidth="1.5" />
        <text fill="currentColor" stroke="none" style={{ font: "500 10.5px var(--mono)", letterSpacing: "0.14em" }}>
          <textPath href={`#${id}-ring`} startOffset="0">
            {ring}
          </textPath>
        </text>
        <text
          x="74"
          y={word.length > 5 ? 78 : 83}
          textAnchor="middle"
          fill="currentColor"
          stroke="none"
          style={{ font: `700 ${word.length > 5 ? 14 : 26}px var(--serif)`, letterSpacing: "0.04em" }}
        >
          {word.toUpperCase()}
        </text>
      </g>
    </svg>
  );
  // Always the same element, so server and client markup match; under reduced motion it jumps to the final pose.
  return (
    <LazyMotion features={domAnimation} strict>
      <m.div
        className={`aspect-square ${className}`}
        initial={land ? { opacity: 0, scale: 1.35, rotate: -4 } : { opacity: 0.94, scale: 1, rotate: -7 }}
        animate={
          animate
            ? { opacity: [0, 1, 0.94], scale: [1.35, 0.97, 1], rotate: [-4, -7, -7] }
            : { opacity: 0.94, scale: 1, rotate: -7 }
        }
        transition={
          animate ? { duration: 0.26, times: [0, 0.6, 1], ease: [0.55, 0, 0.75, 0.2], delay } : { duration: 0 }
        }
      >
        {seal}
      </m.div>
    </LazyMotion>
  );
}
