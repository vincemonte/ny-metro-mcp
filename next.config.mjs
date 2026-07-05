import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the tracing root to this project (avoids Next.js mis-detecting the
  // workspace root when a lockfile happens to exist in a parent directory).
  outputFileTracingRoot: projectRoot,
  // lirr-schedule.json is read with fs at runtime (too large to import as a
  // typed module) — make sure Vercel's file tracing bundles /data.
  outputFileTracingIncludes: {
    "/[transport]": ["./data/**/*"],
  },
};
export default nextConfig;
