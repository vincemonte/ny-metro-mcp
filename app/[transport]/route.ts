import { createMcpHandler } from "mcp-handler";
import { registerTools } from "@/lib/tools";

/**
 * MCP endpoint. With `basePath: ""` and this file at app/[transport]/route.ts,
 * the Streamable HTTP endpoint is served at:
 *
 *   https://<your-deployment>.vercel.app/mcp
 *
 * That URL is what you (and coworkers) paste into Claude's
 * "Add custom connector" dialog.
 */
const handler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  {
    serverInfo: {
      name: "mta-transit",
      version: "0.1.0",
    },
  },
  {
    basePath: "",
    maxDuration: 60,
    verboseLogs: false,
  }
);

export { handler as GET, handler as POST, handler as DELETE };

// Vercel function settings: allow up to 60s (plenty; typical calls are <2s).
export const maxDuration = 60;
