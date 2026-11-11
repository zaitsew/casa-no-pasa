import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Casa No Pasa", template: "%s · Casa No Pasa" },
  description: "No dejamos pasar ni una casa. Reply first and well to new Barcelona rental listings.",
  applicationName: "Casa No Pasa",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
