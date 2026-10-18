#!/usr/bin/env node
import { MAX_TEAM_REPORT_BYTES, ReportError, reportErrorMessage, submitTeamReport } from "./team-report-client.js";

// This command receives only a per-worker reporting capability, never an owner API key.
async function main() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_TEAM_REPORT_BYTES) throw new ReportError("Report exceeds 64 KiB.");
    chunks.push(buffer);
  }
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  await submitTeamReport(input);
  process.stdout.write("Team report recorded. Stop work on this assignment.\n");
}
main().catch((error: unknown) => {
  process.stderr.write(reportErrorMessage(error) + "\n");
  process.exitCode = 1;
});
