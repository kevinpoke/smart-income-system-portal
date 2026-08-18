"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { GlassCard, AccentButton } from "@/components/ui/Primitives";

// This page renders OUTSIDE the (portal) route group's layout, so it never
// receives the authenticated app shell (Sidebar/Header/MobileNav/
// ChatWidget) -- only the Smart Income System branding + login form below.
// proxy.js also treats /login as the one public page, so an authenticated
// session visiting /login still only sees this form (no redirect loop, no
// shell leak either way).
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
        If you&rsquo;re having trouble logging in, please reach out to{" "}
        <a
          href="mailto:support@smartincomesystem.com"
          className="text-[#32B5FF] underline-offset-2 hover:underline"
        >
          support@smartincomesystem.com
        </a>
      </p>
    </GlassCard>
  );
}

export default function LoginPage() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden bg-[#050507] px-4">
      {/* Full-page deep-space background (public/galaxy-bg.png): a single
          realistic galaxy/nebula photo, covered + centered so it always
          fills the viewport without distortion at any aspect ratio.
          Rendered as a plain CSS background (not next/image) since it's
          a full-bleed decorative backdrop, not content -- avoids layout
          shift concerns and keeps this a simple background-position/size
          tweak if the asset is ever swapped. A dark radial overlay sits
          on top so the centered login card always stays readable
          regardless of which part of the image lands behind it. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: "url(/galaxy-bg.png)" }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/55"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(5,5,8,0.35) 0%, rgba(5,5,8,0.75) 65%, rgba(5,5,8,0.92) 100%)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-6">
        {/* Login branding: FULL Smart Income System lockup
            (/public/smart-income-logo.png -- icon + wordmark in one
            image), shown larger here (above the form) than the compact
            icon-only Sidebar/MobileNav mark. object-contain preserves the
            source image's own aspect ratio (never cropped/stretched/
            distorted). Responsive width (clamped, not a fixed huge box)
            keeps this usable on small mobile viewports without pushing
            the form below the fold; the form itself is untouched below
            and stays centered either way. No separate text heading here
            -- the full logo already carries the "SMART INCOME SYSTEM"
            wordmark, so a second text copy would just duplicate it. */}
        <div className="flex flex-col items-center gap-2">
          <Image
            src="/smart-income-logo.png"
            alt="Smart Income System"
            width={1315}
            height={571}
            className="h-auto w-64 object-contain sm:w-80"
            priority
          />
        </div>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
