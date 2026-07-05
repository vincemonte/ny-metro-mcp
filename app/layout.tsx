import type { ReactNode } from "react";

export const metadata = {
  title: "MTA Transit MCP",
  description: "Remote MCP server for MTA subway + LIRR realtime data",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-sans-serif, system-ui", margin: "3rem auto", maxWidth: 640, padding: "0 1rem", lineHeight: 1.6 }}>
        {children}
      </body>
    </html>
  );
}
