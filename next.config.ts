import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // El modo desarrollo (iniciar-local.bat) compila en su propia carpeta. Si
  // compartiera .next con la version de produccion (iniciar-app.bat), al
  // levantarlo borra parte de esa compilacion y la de produccion despues no
  // arranca: "ENOENT ... .next\prerender-manifest.json" (2026-10-27).
  distDir: process.env.PHF_DIST_DIR || ".next",
  experimental: {
    serverActions: {
      // La importacion manda el lote entero en una sola server action
      // (importarComprobantes valida todo antes de grabar nada), y Next corta
      // el cuerpo en 1 MB por defecto: un PDF de 1,9 MB ("Legajo Motos
      // IMSA.pdf", 2026-11-04) fallaba con "An error occurred in the Server
      // Components render" y un 500. Lo que admite la pantalla son 50
      // archivos de 10 MB (MAX_ARCHIVOS y MAX_BYTES en
      // acciones/comprobantes.ts), mas el margen del multipart.
      bodySizeLimit: "510mb",
    },
  },
};

export default nextConfig;
