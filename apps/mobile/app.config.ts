/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigContext } from "expo/config";

export default ({ config }: ConfigContext) => {
  const localFile = join(__dirname, ".local", "eas.json");
  const projectId = process.env.INFINITE_EAS_PROJECT_ID?.trim() ||
    (existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")).projectId : undefined);
  // Android push needs Firebase. Cloud builds get the file from the EAS file variable; local builds read the ignored copy.
  const localFirebase = join(__dirname, ".local", "google-services.json");
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON?.trim() || (existsSync(localFirebase) ? localFirebase : undefined);
  const base = googleServicesFile ? { ...config, android: { ...config.android, googleServicesFile } } : config;

  if (!projectId) return base;
  if (typeof projectId !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(projectId)) {
    throw new Error("Set a valid EAS project UUID in INFINITE_EAS_PROJECT_ID or .local/eas.json.");
  }

  return {
    ...base,
    extra: { ...base.extra, eas: { ...base.extra?.eas, projectId } },
  };
};
