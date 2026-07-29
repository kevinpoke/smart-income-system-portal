import Sidebar from "@/components/layout/Sidebar";
import MobileNav from "@/components/layout/MobileNav";
import Header from "@/components/layout/Header";
import PageTransition from "@/components/layout/PageTransition";

// Authenticated application shell. Only routes inside the (portal) route
// group get the Sidebar/Header/MobileNav -- /login is a sibling route
// outside this group and renders with none of this chrome. proxy.js
// still enforces the actual auth check server-side; this layout split just
// ensures the DOM for the shell is never emitted pre-login.
//
// Portal reliability pass: the bottom-right floating ChatWidget has been
// removed entirely (per spec: "There must be one support conversation
// system only"). It was a second, disconnected chat surface backed by
// the client-side Zustand mock store (lib/store.js sendChatMessage),
// completely separate from the real SQLite-backed Support page/inbox --
// customers could type into either one and admins would only ever see
// messages sent through the real Support page. The main Support page
// (app/(portal)/support/page.js) and its shared backend
// (lib/supportEngine.js, app/api/support/messages,
// app/api/admin/support/*) are the one remaining conversation system.
export default function PortalLayout({ children }) {
  return (
    <>
      <Sidebar />
      <div className="lg:pl-64">
        <Header />
        <main className="mx-auto max-w-7xl px-4 pb-24 pt-6 sm:px-8 lg:pb-10">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
      <MobileNav />
    </>
  );
}

