import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { Sidebar } from "@/components/Sidebar";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Wind Hourly — meter data studio",
  description: "Turn raw wind-turbine exports into hourly meter-data files and quarterly delivery summaries.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full">
        <Suspense fallback={<aside className="w-56 shrink-0 border-r border-line bg-surface" />}>
          <Sidebar />
        </Suspense>
        <main className="min-w-0 flex-1">{children}</main>
      </body>
    </html>
  );
}
