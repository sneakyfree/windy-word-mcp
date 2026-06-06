// Contract / smoke test for CI.
//
// Spawns the MCP server over stdio, asks it for its tool list, and asserts:
//   1. the server registers at least MIN_TOOLS tools,
//   2. every tool has a non-empty name + description,
//   3. every tool's inputSchema is a structurally valid JSON Schema object,
//   4. tool names are unique.
//
// This does NOT require Windy Word to be running — it only exercises the MCP
// registration + schema-compilation path, which is what we want to guard in CI.
// Exits 0 on success, 1 on any failed assertion.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Floor, not the exact count — keeps the test from being brittle as tools are
// added, while still catching a catastrophic "nothing registered" regression.
const MIN_TOOLS = 100;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, '..', 'bin', 'windy-word-mcp.js');

const failures = [];
function check(cond, message) {
  if (!cond) failures.push(message);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
});

const client = new Client({ name: 'contract-test', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();

check(
  Array.isArray(tools) && tools.length >= MIN_TOOLS,
  `expected at least ${MIN_TOOLS} tools, got ${Array.isArray(tools) ? tools.length : 'non-array'}`,
);

const seen = new Set();
for (const t of tools) {
  const id = t?.name || '(unnamed)';
  check(typeof t.name === 'string' && t.name.length > 0, `tool ${id}: missing/empty name`);
  check(typeof t.description === 'string' && t.description.trim().length > 0, `tool ${id}: missing/empty description`);

  // Every MCP tool must expose a JSON Schema object for its input.
  const schema = t.inputSchema;
  check(schema && typeof schema === 'object' && !Array.isArray(schema), `tool ${id}: inputSchema is not an object`);
  if (schema && typeof schema === 'object') {
    check(schema.type === 'object', `tool ${id}: inputSchema.type must be "object", got ${JSON.stringify(schema.type)}`);
    check(
      schema.properties === undefined || (typeof schema.properties === 'object' && !Array.isArray(schema.properties)),
      `tool ${id}: inputSchema.properties is not an object`,
    );
    // It must round-trip through JSON — i.e. it actually serializes/compiles.
    try {
      JSON.parse(JSON.stringify(schema));
    } catch (e) {
      check(false, `tool ${id}: inputSchema does not serialize as JSON: ${e.message}`);
    }
  }

  check(!seen.has(t.name), `duplicate tool name: ${t.name}`);
  seen.add(t.name);
}

await client.close();

if (failures.length > 0) {
  console.error(`Contract test FAILED with ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(`Contract test PASSED: ${tools.length} tools enumerated, all schemas valid, names unique.`);
process.exit(0);
