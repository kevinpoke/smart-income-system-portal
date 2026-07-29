"use client";

import { useCallback, useEffect, useState } from "react";
import { GlassCard, AccentButton, Badge } from "@/components/ui/Primitives";
import { CheckCircle2, XCircle, Mail, Zap, RefreshCw } from "lucide-react";

const TEST_PAYLOAD = {
  email: "test@example.com",
  name: "Test User",
  password: "Password123",
};

// Refinement pass: moved out of the combined admin/page.js "Users" tab
// into its own dedicated /admin/test tab/page (per spec: named exactly
// "Test"). Same underlying behavior as before -- fires a mock purchase
// webhook to /api/webhooks/purchase and shows the outbox email log --
// just no longer sharing screen space with the ISP approval panel or the
// User Management table.
export default function AdminTestPage() {
  const [status, setStatus] = useState("idle"); // idle | loading | success | error
  const [result, setResult] = useState(null);
  const [recentEmails, setRecentEmails] = useState([]);
  const [loadingEmails, setLoadingEmails] = useState(true);

  const loadEmails = useCallback(async () => {
    setLoadingEmails(true);
    try {
      const res = await fetch("/api/admin/accounts?pageSize=1", { cache: "no-store" });
      const data = await res.json();
      setRecentEmails(data.recentEmails || []);
    } catch {
      // outbox list just stays stale
    } finally {
      setLoadingEmails(false);
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadEmails();
  }, [loadEmails]);

  async function handleSimulate() {
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch("/api/webhooks/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(TEST_PAYLOAD),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setResult(data);
        return;
      }
      setStatus("success");
      setResult(data);
      await loadEmails();
    } catch (err) {
      setStatus("error");
      setResult({ error: err.message });
    }
  }

  return (
    <GlassCard className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Test Scenario: Simulate JVZoo Purchase</h3>
          <p className="text-xs text-[#B0B0B0]">
            Sends a mock webhook payload ({TEST_PAYLOAD.email} / {TEST_PAYLOAD.password}) to{" "}
            <code>/api/webhooks/purchase</code> and creates a real account in the auth database.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadEmails}
            title="Refresh email log"
            className="flex items-center gap-1 rounded-lg bg-white/5 px-3 py-2.5 text-xs font-semibold text-[#B0B0B0] hover:bg-white/10"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingEmails ? "animate-spin" : ""}`} />
          </button>
          <AccentButton onClick={handleSimulate} disabled={status === "loading"}>
            <Zap className="h-4 w-4" />
            {status === "loading" ? "Sending..." : "Simulate JVZoo Purchase"}
          </AccentButton>
        </div>
      </div>

      {result && (
        <div className="border-b border-white/10 px-5 py-3">
          {status === "success" ? (
            <Badge tone="success" className="mb-2">
              <CheckCircle2 className="mr-1 h-3 w-3" /> Webhook succeeded
            </Badge>
          ) : (
            <Badge tone="danger" className="mb-2">
              <XCircle className="mr-1 h-3 w-3" /> Webhook failed
            </Badge>
          )}
          <pre className="max-h-40 overflow-auto rounded-lg bg-black/30 p-3 text-[11px] text-[#B0B0B0]">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      <div className="px-5 py-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#707070]">
          Email Log (outbox — &quot;Email Sent&quot; logic)
        </h4>
        {recentEmails.length === 0 ? (
          <p className="text-xs text-[#707070]">No emails sent yet.</p>
        ) : (
          <ul className="space-y-1">
            {recentEmails.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-xs text-[#B0B0B0]">
                <Mail className="h-3 w-3 text-[#32B5FF]" />
                <span className="font-mono text-white">{m.to_email}</span>
                <span>— {m.subject}</span>
                <Badge tone={m.sent_via === "sendgrid" ? "success" : "default"} className="text-[10px]">
                  {m.sent_via}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </GlassCard>
  );
}
