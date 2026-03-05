import { execFile } from "node:child_process";
import { getGoogleAccessToken } from "./google.js";

/**
 * Execute a Google Workspace CLI (gws) command with automatic OAuth token injection.
 * @param args Positional args, e.g. ["drive", "files", "list"]
 * @param opts.params URL/path parameters (--params JSON)
 * @param opts.json   Request body (--json JSON)
 */
export async function runGws(
  args: string[],
  opts?: { params?: Record<string, unknown>; json?: unknown },
): Promise<unknown> {
  const token = await getGoogleAccessToken("google_workspace");

  const fullArgs = [...args];
  if (opts?.params) {
    fullArgs.push("--params", JSON.stringify(opts.params));
  }
  if (opts?.json) {
    fullArgs.push("--json", JSON.stringify(opts.json));
  }

  return new Promise((resolve, reject) => {
    execFile(
      "gws",
      fullArgs,
      {
        env: { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: token },
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message;
          return reject(new Error(`gws ${args.join(" ")} failed: ${msg}`));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(stdout.trim());
        }
      },
    );
  });
}
