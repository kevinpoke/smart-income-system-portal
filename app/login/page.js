"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { GlassCard, AccentButton } from "@/components/ui/Primitives";

// This page renders OUTSIDE the (portal) route group's layout, so it never
// receives the authenticated app shell (Sidebar/Header/MobileNav/
// ChatWidget) -- only the StarAtlas branding + login form below. proxy.js
// also treats /login as the one public page, so an authenticated session
// visiting /login still only sees this form (no redirect loop, no shell
// leak either way).
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed.");
        return;
      }
      router.push(next);
      router.refresh();
    } catch (err) {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <GlassCard className="w-full max-w-sm p-8">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-[#B0B0B0]">
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-[#B0B0B0]">
            Password
          </label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            placeholder="••••••••"
          />
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <AccentButton type="submit" disabled={loading} className="w-full">
          {loading ? "Signing in…" : "Sign In"}
        </AccentButton>
      </form>

      <p className="mt-5 text-center text-xs text-[#707070]">
        Bought the program? Check your email for a temporary password.
      </p>
    </GlassCard>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#121212] px-4">
      {/* Login branding: single shared /public/star-atlas-logo.png asset,
          shown larger here (above the form) than the compact Sidebar
          version -- same object-contain treatment preserves the source
          image's own aspect ratio (never cropped/stretched/distorted).
          Responsive width (clamped, not a fixed huge box) keeps this
          usable on small mobile viewports without pushing the form
          below the fold; the form itself is untouched below and stays
          centered either way. */}
      <Image
        src="/star-atlas-logo.png"
        alt="STAR ATLAS Rewards Network"
        width={1448}
        height={1086}
        className="h-auto w-40 object-contain sm:w-48"
        priority
      />
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
