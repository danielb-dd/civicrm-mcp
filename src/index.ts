#!/usr/bin/env node
/**
 * CiviCRM MCP Server
 *
 * Provides tools to interact with CiviCRM via its APIv4 REST interface.
 * Covers Contacts, Activities, Contributions, Events, Participants,
 * Memberships, Groups, Relationships, Cases, and a generic API tool.
 *
 * Environment variables:
 *   CIVICRM_BASE_URL   - Base URL of your CiviCRM installation (required)
 *   CIVICRM_API_KEY    - Your CiviCRM API key (required)
 *   TRANSPORT          - Transport type: 'stdio' (default) or 'http'
 *   PORT               - HTTP port when using 'http' transport (default: 3000)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

import { registerContactTools } from './tools/contacts.js';
import { registerActivityTools } from './tools/activities.js';
import { registerContributionTools } from './tools/contributions.js';
import { registerEventTools } from './tools/events.js';
import { registerMembershipTools } from './tools/memberships.js';
import { registerGroupTools } from './tools/groups.js';
import { registerRelationshipTools } from './tools/relationships.js';
import { registerCaseTools } from './tools/cases.js';
import { registerGenericTools } from './tools/generic.js';

function validateEnv(): void {
  const missing: string[] = [];
  if (!process.env.CIVICRM_BASE_URL) missing.push('CIVICRM_BASE_URL');
  if (!process.env.CIVICRM_API_KEY) missing.push('CIVICRM_API_KEY');

  if (missing.length > 0) {
    console.error(`ERROR: Missing required environment variables: ${missing.join(', ')}`);
    console.error('');
    console.error('Set them before running:');
    console.error('  export CIVICRM_BASE_URL="https://your-civicrm-site.org"');
    console.error('  export CIVICRM_API_KEY="your-api-key"');
    process.exit(1);
  }
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'civicrm-mcp-server',
    version: '1.0.0',
  });

  // Register all domain tools
  registerContactTools(server);
  registerActivityTools(server);
  registerContributionTools(server);
  registerEventTools(server);
  registerMembershipTools(server);
  registerGroupTools(server);
  registerRelationshipTools(server);
  registerCaseTools(server);
  registerGenericTools(server);

  return server;
}

async function runStdio(): Promise<void> {
  validateEnv();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`CiviCRM MCP Server running via stdio`);
  console.error(`Connected to: ${process.env.CIVICRM_BASE_URL}`);
}

async function runHTTP(): Promise<void> {
  validateEnv();
  const server = createServer();
  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'civicrm-mcp-server', version: '1.0.0' });
  });

  // MCP endpoint — stateless, creates a new transport per request
  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => { void transport.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body as Record<string, unknown>);
  });

  const port = parseInt(process.env.PORT ?? '3000', 10);
  app.listen(port, () => {
    console.error(`CiviCRM MCP Server running on http://localhost:${port}/mcp`);
    console.error(`Connected to: ${process.env.CIVICRM_BASE_URL}`);
    console.error(`Health check: http://localhost:${port}/health`);
  });
}

// Entry point
const transport = process.env.TRANSPORT ?? 'stdio';

if (transport === 'http') {
  runHTTP().catch((error: unknown) => {
    console.error('Server startup error:', error);
    process.exit(1);
  });
} else {
  runStdio().catch((error: unknown) => {
    console.error('Server startup error:', error);
    process.exit(1);
  });
}
