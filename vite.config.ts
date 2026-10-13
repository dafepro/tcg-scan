import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { referenceInstallerPlugin } from "./server/reference-installer";
import { ortRuntimePackagingPlugin } from "./server/runtime-packaging";
export default defineConfig({
  plugins: [react(), referenceInstallerPlugin(), ortRuntimePackagingPlugin()],
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
  },
});
