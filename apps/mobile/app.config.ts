/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigContext } from "expo/config";

export default ({ config }: ConfigContext) => {
  const localFile = join(__dirname, ".local", "eas.json");
  const projectId = process.env.INFINITE_EAS_PROJECT_ID?.trim() ||
    (existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")).projectId : undefined);

  if (!projectId) return config;
  if (typeof projectId !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(projectId)) {
    throw new Error("Set a valid EAS project UUID in INFINITE_EAS_PROJECT_ID or .local/eas.json.");
  }

  return {
    ...config,
    extra: { ...config.extra, eas: { ...config.extra?.eas, projectId } },
  };
};
