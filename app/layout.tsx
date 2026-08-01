import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./controls.css";

export const metadata: Metadata = {
  title: "CARVIS",
  description: "A voice-first assistant. Talk to it, and it talks back.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon.svg",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "CARVIS",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#04060d",
  width: "device-width",
  initialScale: 1,
  // cover: without it, env(safe-area-inset-*) is 0 on iOS and the composer
  // sits inside the home-indicator gesture zone. maximumScale deliberately
  // absent — it blocked pinch-zoom on Android (an accessibility failure) and
  // bought nothing: every input is 16px, so iOS never focus-zooms anyway.
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="vignette" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
