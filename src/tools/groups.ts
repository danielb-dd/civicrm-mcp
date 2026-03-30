import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCiviCRM, handleToolError, truncateIfNeeded, buildPagination } from '../services/civicrm.js';
import { ResponseFormat } from '../types.js';
import { DEFAULT_LIMIT, MAX_LIMIT, zId, zOptionalId, zLimit, zOffset } from '../constants.js';

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

export function registerGroupTools(server: McpServer): void {
  // ── Get Groups ────────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_groups',
    {
      title: 'Search/List CiviCRM Groups',
      description: `Search and list contact groups in CiviCRM. Groups are used to organize contacts for mailing lists, access control, and reporting.

Args:
  - title (string, optional): Filter by group title (partial match)
  - group_type (string, optional): Filter by group type (e.g., "Mailing List", "Access Control")
  - is_active (boolean, optional): Filter by active status (default: shows all)
  - limit (number, default 25, max 500): Maximum results
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of groups with id, title, description, type, and member count.`,
      inputSchema: z.object({
        title: z.string().optional().describe('Filter by group title (partial match)'),
        group_type: z.string().optional().describe('Group type (e.g., "Mailing List")'),
        is_active: z.boolean().optional().describe('Filter by active status'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ title, group_type, is_active, limit, offset, response_format }) => {
      try {
        const where: [string, string, unknown][] = [];
        if (title) where.push(['title', 'LIKE', `%${title}%`]);
        if (group_type) where.push(['group_type:label', 'CONTAINS', group_type]);
        if (is_active !== undefined) where.push(['is_active', '=', is_active]);

        const result = await callCiviCRM('Group', 'get', {
          select: ['id', 'name', 'title', 'description', 'group_type:label', 'is_active',
            'is_hidden', 'count'],
          where,
          limit,
          offset,
          orderBy: { title: 'ASC' },
        });

        const groups = result.values ?? [];
        const pagination = buildPagination(result.countMatched, groups.length, offset, limit);

        if (groups.length === 0) {
          return { content: [{ type: 'text', text: 'No groups found matching the given criteria.' }] };
        }

        const output = { ...pagination, groups };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# CiviCRM Groups (${groups.length} shown)`, ''];
          for (const g of groups as Record<string, unknown>[]) {
            lines.push(`## ${g['title']} (ID: ${g['id']})`);
            if (g['description']) lines.push(`- **Description**: ${g['description']}`);
            if (g['group_type:label']) lines.push(`- **Type**: ${JSON.stringify(g['group_type:label'])}`);
            lines.push(`- **Active**: ${g['is_active'] ? 'Yes' : 'No'}`);
            if (g['count'] !== undefined) lines.push(`- **Members**: ${g['count']}`);
            lines.push('');
          }
          if (pagination.has_more) {
            lines.push(`*Use offset=${pagination.next_offset} to see more results.*`);
          }
          text = lines.join('\n');
        }

        return {
          content: [{ type: 'text', text: truncateIfNeeded(text) }],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

  // ── Get Group Contacts ────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_group_contacts',
    {
      title: 'Get Contacts in a CiviCRM Group',
      description: `List contacts that are members of a specific CiviCRM group.

Args:
  - group_id (number): The group ID to list members of
  - status (string, optional): Member status filter (e.g., "Added", "Removed", "Pending"); default shows "Added" members
  - limit (number, default 25, max 500): Maximum results
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of contacts in the group with id, display_name, email, and membership status.`,
      inputSchema: z.object({
        group_id: zId.describe('Group ID to list members of'),
        status: z.string().default('Added').describe('Member status (e.g., "Added", "Removed", "Pending")'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, status, limit, offset, response_format }) => {
      try {
        const result = await callCiviCRM('GroupContact', 'get', {
          select: ['id', 'contact_id', 'contact_id.display_name', 'contact_id.email_primary.email',
            'contact_id.contact_type', 'status', 'group_id'],
          where: [
            ['group_id', '=', group_id],
            ['status', '=', status],
          ],
          limit,
          offset,
        });

        const members = result.values ?? [];
        const pagination = buildPagination(result.countMatched, members.length, offset, limit);

        if (members.length === 0) {
          return { content: [{ type: 'text', text: `No contacts found in group ${group_id} with status "${status}".` }] };
        }

        const output = { ...pagination, group_id, status, members };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# Group ${group_id} Members (${members.length} shown, status: ${status})`, ''];
          for (const m of members as Record<string, unknown>[]) {
            const name = m['contact_id.display_name'] ?? `Contact ${m['contact_id']}`;
            const email = m['contact_id.email_primary.email'];
            lines.push(`- **${name}** (ID: ${m['contact_id']})${email ? ` — ${email}` : ''}`);
          }
          if (pagination.has_more) {
            lines.push(`\n*Use offset=${pagination.next_offset} to see more results.*`);
          }
          text = lines.join('\n');
        }

        return {
          content: [{ type: 'text', text: truncateIfNeeded(text) }],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

  // ── Manage Group Contact ──────────────────────────────────────────────────
  server.registerTool(
    'civicrm_manage_group_contact',
    {
      title: 'Add or Remove Contact from CiviCRM Group',
      description: `Add or remove a contact from a CiviCRM group.

Args:
  - contact_id (number): Contact ID
  - group_id (number): Group ID
  - action ('add'|'remove'): Whether to add or remove the contact

Returns:
  Confirmation message.

Examples:
  - Add contact 42 to group 5: contact_id=42, group_id=5, action="add"
  - Remove contact from mailing list: contact_id=100, group_id=3, action="remove"`,
      inputSchema: z.object({
        contact_id: zId.describe('Contact ID'),
        group_id: zId.describe('Group ID'),
        action: z.enum(['add', 'remove']).describe('Whether to add or remove the contact from the group'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ contact_id, group_id, action }) => {
      try {
        if (action === 'add') {
          await callCiviCRM('GroupContact', 'create', {
            values: { contact_id, group_id, status: 'Added' },
          });
          return { content: [{ type: 'text', text: `Contact ${contact_id} added to group ${group_id}.` }] };
        } else {
          await callCiviCRM('GroupContact', 'delete', {
            where: [
              ['contact_id', '=', contact_id],
              ['group_id', '=', group_id],
            ],
          });
          return { content: [{ type: 'text', text: `Contact ${contact_id} removed from group ${group_id}.` }] };
        }
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );
}
