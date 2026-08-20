// Probe an ACP server over stdio: spawn, send initialize, print the reply.
// Usage: node acp-probe.mjs -- <command> [args...]
// On Windows, pass `node <path-to-js>` for a JS-entry CLI.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: node acp-probe.mjs -- <command> [args...]");
  process.exit(2);
}

const child = spawn(cmd, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
});

const lines = createInterface({ input: child.stdout });
const stderrLines = [];
createInterface({ input: child.stderr }).on("line", (l) => stderrLines.push(l));

let sent = false;
const timer = setTimeout(() => {
  console.error(`[probe] TIMEOUT after ${Date.now() - start}ms`);
  child.kill("SIGKILL");
  process.exit(3);
}, 25000);
const start = Date.now();

lines.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  console.log(`[rcv ${Date.now() - start}ms] ${t}`);
  try {
    const msg = JSON.parse(t);
    // On initialize response, send session/new then prompt.
    if (msg.id === 1 && msg.result) {
      if (!sent) {
        sent = true;
        const sessionReq = {
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: process.cwd(), mcpServers: [] },
        };
        child.stdin.write(JSON.stringify(sessionReq) + "\n");
      }
    } else if (msg.id === 2 && msg.result) {
      const promptReq = {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: msg.result.sessionId,
          prompt: [{ type: "text", text: "Reply with exactly: PONG" }],
        },
      };
      child.stdin.write(JSON.stringify(promptReq) + "\n");
    } else if (msg.id === 3 && msg.result) {
      console.log(`[done] stopReason=${msg.result.stopReason}`);
      clearTimeout(timer);
      child.kill("SIGKILL");
      process.exit(0);
    }
  } catch {}
});

child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "dsh-acp-probe", version: "0.0.1" },
    },
  }) + "\n"
);

child.on("exit", (code) => {
  if (!sent && code !== null) {
    console.error(`[probe] child exited code=${code}`);
    console.error("--- stderr ---");
    console.error(stderrLines.slice(0, 30).join("\n"));
    clearTimeout(timer);
    process.exit(4);
  }
});
