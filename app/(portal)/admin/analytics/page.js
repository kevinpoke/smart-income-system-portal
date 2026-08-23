"use client";

// Dedicated, peer-level Admin Analytics page. Analytics used to live as
// an internal tab inside Support Chats (see git history of
// app/(portal)/admin/chats/page.js) -- per spec "Analytics must NOT be
// inside Support Chats," it has been moved out to its own top-level
// route/nav item. All calculation/metric logic is untouched: this page
// simply renders the same AnalyticsPanel component (extracted verbatim
// from the old inline AnalyticsTab) that already talks to the existing
// /api/admin/support/analytics endpoint.
import AnalyticsPanel from "@/components/admin/AnalyticsPanel";

export default function AdminAnalyticsPage() {
  return <AnalyticsPanel />;
}
