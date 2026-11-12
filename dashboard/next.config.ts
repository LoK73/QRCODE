import type { NextConfig } from "next";

const config: NextConfig = {
  // La dashboard parla con Postgres dal server: il driver resta fuori dal bundle.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default config;
