import type { NextConfig } from "next";

// Static export: the app has no server code, so `next build` writes plain files to out/ that any
// static host serves (drag the folder onto Netlify Drop, or push to Vercel). `next dev` is unchanged.
const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
