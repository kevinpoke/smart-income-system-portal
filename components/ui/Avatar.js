"use client";

import clsx from "clsx";

// Shared avatar renderer: shows the account's uploaded profile photo if
// set, otherwise a circular initial-letter avatar. Per spec: "Use the
// first letter of the displayed first name. If first name is missing,
// use the first letter of the email." Used everywhere an identity needs
// to be shown (top-right profile area, Support chat messages, admin
// Support Chats inbox).
export default function Avatar({ photoUrl, firstName, email, size = 32, className = "" }) {
  const initial = (firstName?.trim()?.[0] || email?.trim()?.[0] || "?").toUpperCase();
  const dimension = `${size}px`;

  if (photoUrl) {
    return (
      // Local files served from /public/uploads (same-origin, user-
      // uploaded) -- next/image's remote-optimization pipeline isn't
      // needed here, and this codebase's eslint config doesn't flag
      // no-img-element as an error, only a warning.
      <img
        src={photoUrl}
        alt={firstName ? `${firstName}'s profile photo` : "Profile photo"}
        width={size}
        height={size}
        className={clsx("rounded-full object-cover", className)}
        style={{ width: dimension, height: dimension }}
      />
    );
  }

  return (
    <span
      className={clsx(
        "flex flex-shrink-0 items-center justify-center rounded-full bg-[#32B5FF]/20 font-bold text-[#32B5FF]",
        className
      )}
      style={{ width: dimension, height: dimension, fontSize: `${Math.max(10, size * 0.42)}px` }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
