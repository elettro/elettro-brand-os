import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Elettro Brand OS",
  description: "Create. Approve. The engine distributes."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
