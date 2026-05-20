// Smoke test: spawn the MCP server over stdio, ask it for its tool list,
// pretty-print names + descriptions, exit. If Windy Word is running, also
// call get_platform end-to-end so we know the HTTP wiring actually works.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, '..', 'bin', 'windy-word-mcp.js');

const transport = new StdioClientTransport({
  command: process.execPath, // current node binary
  args: [serverEntry],
});

const client = new Client({ name: 'smoke-test', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Server registered ${tools.length} tool(s):\n`);
for (const t of tools) {
  const desc = (t.description || '').replace(/\s+/g, ' ').trim();
  const short = desc.length > 110 ? desc.slice(0, 107) + '...' : desc;
  console.log(`  • ${t.name.padEnd(28)} ${short}`);
}

// End-to-end check against the running Windy Word, if any.
try {
  console.log('\nCalling get_platform end-to-end...');
  const result = await client.callTool({ name: 'get_platform', arguments: {} });
  const text = result.content?.[0]?.text || '(no content)';
  if (result.isError) {
    console.log(`  → tool reported error (Windy Word probably not running):`);
    console.log(`  ${text.split('\n').join('\n  ')}`);
  } else {
    console.log(`  ${text.split('\n').join('\n  ')}`);
  }
} catch (e) {
  console.log(`  → unexpected error: ${e.message}`);
}

await client.close();
process.exit(0);
