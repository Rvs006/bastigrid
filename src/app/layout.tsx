import type { Metadata, Viewport } from "next";
import { Chakra_Petch, Chivo_Mono } from "next/font/google";
import "./globals.css";
import PwaRegister from "@/components/PwaRegister";

const chakra = Chakra_Petch({
  variable: "--font-chakra",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const chivo = Chivo_Mono({
  variable: "--font-chivo",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
});

export const metadata: Metadata = {
  title: "BastiGrid",
  description:
    "3D clearance routing for emergency crews in dense informal settlements: does the stretcher fit, does the hose reach.",
  manifest: "/manifest.json",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
  appleWebApp: { capable: true, title: "BastiGrid", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#f7f6f2",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${chakra.variable} ${chivo.variable} h-full`}>
      <body className="h-full">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
