import "./globals.css";

// Root layout only sets up the HTML shell + global styles. The authenticated
// app chrome (Sidebar, Header, MobileNav, ChatWidget) lives in
// app/(portal)/layout.js so unauthenticated routes -- currently just
// /login -- never render any of it, satisfying the requirement that the
// login screen show only the login card and nothing from the authenticated
// shell (no sidebar, header, connection status, nav, dashboard content).
export const metadata = {
  title: "Star Atlas Rewards Portal",
  description: "Earn passive income by sharing your unused internet bandwidth.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#121212] font-sans text-white antialiased">
        {children}
      </body>
    </html>
  );
}
