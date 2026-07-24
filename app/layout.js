import "./globals.css";
import Sidebar from "@/components/layout/Sidebar";
import MobileNav from "@/components/layout/MobileNav";
import Header from "@/components/layout/Header";
import ChatWidget from "@/components/ChatWidget";
import PageTransition from "@/components/layout/PageTransition";

export const metadata = {
  title: "Star Atlas Rewards Portal",
  description: "Earn passive income by sharing your unused internet bandwidth.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#121212] font-sans text-white antialiased">
        <Sidebar />
        <div className="lg:pl-64">
          <Header />
          <main className="mx-auto max-w-7xl px-4 pb-24 pt-6 sm:px-8 lg:pb-10">
            <PageTransition>{children}</PageTransition>
          </main>
        </div>
        <MobileNav />
        <ChatWidget />
      </body>
    </html>
  );
}
