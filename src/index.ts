#!/usr/bin/env node
/**
 * CiviCRM MCP Server
 *
 * Provides tools to interact with CiviCRM via its APIv4 REST interface.
 * Covers Contacts, Activities, Contributions, Events, Participants,
 * Memberships, Groups, Relationships, Cases, and a generic API tool.
 *
 * Environment variables (multi-site):
 *   CIVICRM_SITE_<SLUG>_URL   - Base URL for a site (e.g. CIVICRM_SITE_WESSEX_URL)
 *   CIVICRM_SITE_<SLUG>_KEY   - API key for that site (e.g. CIVICRM_SITE_WESSEX_KEY)
 *
 * Legacy single-site fallback (still supported):
 *   CIVICRM_BASE_URL   - Base URL of your CiviCRM installation
 *   CIVICRM_API_KEY    - Your CiviCRM API key
 *
 * Other:
 *   TRANSPORT   - Transport type: 'stdio' (default) or 'http'
 *   PORT        - HTTP port when using 'http' transport (default: 3000)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import express from 'express';

import {
  loadSiteRegistry,
  getAvailableSites,
  selectSite,
  handleToolError,
} from './services/civicrm.js';
import { registerContactTools } from './tools/contacts.js';
import { registerActivityTools } from './tools/activities.js';
import { registerContributionTools } from './tools/contributions.js';
import { registerEventTools } from './tools/events.js';
import { registerMembershipTools } from './tools/memberships.js';
import { registerGroupTools } from './tools/groups.js';
import { registerRelationshipTools } from './tools/relationships.js';
import { registerCaseTools } from './tools/cases.js';
import { registerGenericTools } from './tools/generic.js';

function createServer(): McpServer {
  const server = new McpServer({
    name: 'civicrm-mcp-server',
    version: '1.0.0',
  });

  // ── Site selector ─────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_use_site',
    {
      title: 'Select CiviCRM Site',
      description: `Set the active CiviCRM site for this session. All subsequent API calls will target this site until changed.

Args:
  - site (string): Site slug (e.g. "wessex", "lmc-north"). Call with no argument or "list" to see available sites.

Returns:
  Confirmation of the selected site URL, or a list of available sites.`,
      inputSchema: z.object({
        site: z.string().min(1).describe('Site slug to activate, or "list" to see available sites'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ site }) => {
      if (site === 'list') {
        const sites = getAvailableSites();
        return {
          content: [{ type: 'text', text: `Available sites:\n${sites.map(s => `  - ${s}`).join('\n')}` }],
        };
      }
      try {
        const selected = selectSite(site);
        return {
          content: [{ type: 'text', text: `Now using site: **${selected.slug}** (${selected.url})` }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

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
  loadSiteRegistry();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CiviCRM MCP Server running via stdio');
  const sites = getAvailableSites();
  if (sites.length === 1) {
    // Auto-select when there is only one site (legacy / single-site)
    selectSite(sites[0]);
  } else {
    console.error(`Sites available: ${sites.join(', ')} — use civicrm_use_site to select one`);
  }
}

async function runHTTP(): Promise<void> {
  loadSiteRegistry();
  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'civicrm-mcp-server', version: '1.0.0', sites: getAvailableSites() });
  });

  // MCP endpoint — stateless, creates a new transport per request
  app.post('/mcp', async (req, res) => {
    const server = createServer();
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
