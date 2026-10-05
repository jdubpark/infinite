// Codex command hook → POST to the worker's loopback hook listener. Never prints, always exits 0.
const route = process.argv[2] ?? "codex";
const url = process.env.INFINITE_HOOK_URL;
const token = process.env.INFINITE_HOOK_TOKEN;
const deadline = setTimeout(() => process.exit(0), 2000);
async function main() {
  if (!url || !token) return;
  let body = process.argv[3];
  if (!body) {
    body = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      body += chunk;
      if (body.length > 256 * 1024) return;
    }
  }
  await fetch(`${url}/${route}`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(1500),
  }).catch(() => {});
}
main()
  .catch(() => {})
  .finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
