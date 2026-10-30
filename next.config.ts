import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // El modo desarrollo (iniciar-local.bat) compila en su propia carpeta. Si
  // compartiera .next con la version de produccion (iniciar-app.bat), al
  // levantarlo borra parte de esa compilacion y la de produccion despues no
  // arranca: "ENOENT ... .next\prerender-manifest.json" (2026-10-27).
  distDir: process.env.PHF_DIST_DIR || ".next",
};

export default nextConfig;
