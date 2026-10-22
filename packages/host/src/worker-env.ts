export function addProjectIdToLaunchEnv(env: Record<string, string>, projectId: string | undefined) {
  if (typeof projectId === "string" && /^[A-Za-z0-9._-]+$/.test(projectId))
    env.INFINITE_PROJECT_ID = projectId;
}
