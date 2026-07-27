import Sidebar from "@/components/layout/Sidebar";
import MobileNav from "@/components/layout/MobileNav";
import Header from "@/components/layout/Header";
import ChatWidget from "@/components/ChatWidget";
import PageTransition from "@/components/layout/PageTransition";

// Authenticated application shell. Only routes inside the (portal) route
// group get the Sidebar/Header/MobileNav/ChatWidget -- /login is a sibling
// route outside this group and renders with none of this chrome. proxy.js
// still enforces the actual auth check server-side; this layout split just
// ensures the DOM for the shell is never emitted pre-login.
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
      <ChatWidget />
    </>
  );
}
