#!/usr/bin/env node
/**
 * Oath Keeper delivery helper — uses the Letta Agent SDK to deliver oaths
 * to existing conversations with full tool access (Bash, Read, Edit, Write).
 *
 * Usage: node deliver-oath.mjs <conversationId> <prompt>
 *
 * Requires: App Server running at ws://127.0.0.1:4500
 *           SDK installed at ~/.letta/sdk/
 */

import { LettaAgentClient } from "/home/rhomancer/.letta/sdk/node_modules/@letta-ai/letta-agent-sdk/dist/index.js";
import ws from "/home/rhomancer/.letta/sdk/node_modules/ws/index.js";

const WebSocket = ws.WebSocket || ws;

const [conversationId, prompt] = process.argv.slice(2);

if (!conversationId || !prompt) {
  console.error("Usage: deliver-oath.mjs <conversationId> <prompt>");
  process.exit(1);
}

async function main() {
  const client = new LettaAgentClient({
    backend: "remote",
    url: "http://127.0.0.1:4500",
    WebSocket: WebSocket,
  });

  try {
    const session = client.resumeSession(conversationId);
    await session.send(prompt);

    let assistantText = "";
    for await (const message of session.stream()) {
      if (message.type === "assistant" && message.content) {
        assistantText += message.content;
      }
      if (message.type === "result") {
        break;
      }
    }

    session.close();
    
    console.log(assistantText.slice(0, 2000));
    process.exit(0);
  } catch (e) {
    console.error("Delivery error:", e.message || e);
    process.exit(1);
  }
}

setTimeout(() => {
  console.error("Delivery timeout after 120s");
  process.exit(2);
}, 120_000);

main().catch((e) => {
  console.error("Fatal:", e.message || e);
  process.exit(1);
});
