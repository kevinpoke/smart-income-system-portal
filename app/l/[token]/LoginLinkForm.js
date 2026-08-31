"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { GlassCard, AccentButton } from "@/components/ui/Primitives";

// PASSWORDLESS-CUSTOMER-LOGIN batch: client half of the unique
// login-link flow. Mirrors app/login/page.js's visual shell exactly
// (same background, same logo, same card) but asks for Email only --
// no password field exists anywhere in this component (spec Part 1:
// "NO password required for customer login").
export default function LoginLinkForm({ token }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login-link/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Deliberately the SAME generic message whether the email was
        // simply wrong, or (defensively) anything else server-side
        // failed post-resolution -- never reveals the expected email
        // or any account detail (spec Part 5).
        setError(data.error || "Invalid login link or email.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden bg-[#050507] px-4">
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

        <GlassCard className="w-full max-w-sm p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-[#B0B0B0]">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
                placeholder="you@example.com"
                autoFocus
              />
            </div>

            {error && (
              <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}

            <AccentButton type="submit" disabled={loading} className="w-full">
              {loading ? "Logging in…" : "Login"}
            </AccentButton>
          </form>

          <p className="mt-5 text-center text-xs text-[#707070]">
            If you&rsquo;re having trouble logging in, please reach out to{" "}
            <a
              href="mailto:jenny@smart-income-system.com"
              className="text-[#32B5FF] underline-offset-2 hover:underline"
            >
              jenny@smart-income-system.com
            </a>
          </p>
        </GlassCard>
      </div>
    </div>
  );
}
