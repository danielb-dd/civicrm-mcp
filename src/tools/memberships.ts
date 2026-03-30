import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCiviCRM, handleToolError, truncateIfNeeded, buildPagination } from '../services/civicrm.js';
import { ResponseFormat } from '../types.js';
import { DEFAULT_LIMIT, MAX_LIMIT, zId, zOptionalId, zLimit, zOffset } from '../constants.js';

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

function formatMembershipMarkdown(m: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`## ${m['contact_id.display_name'] ?? `Contact ${m['contact_id']}`} (Membership ID: ${m['id']})`);
  lines.push(`- **Type**: ${m['membership_type_id:label'] ?? m['membership_type_id'] ?? 'Unknown'}`);
  lines.push(`- **Status**: ${m['status_id:label'] ?? m['status_id'] ?? 'Unknown'}`);
  if (m['start_date']) lines.push(`- **Start**: ${m['start_date']}`);
  if (m['end_date']) lines.push(`- **End**: ${m['end_date']}`);
  if (m['join_date']) lines.push(`- **Joined**: ${m['join_date']}`);
  if (m['source']) lines.push(`- **Source**: ${m['source']}`);
  lines.push('');
  return lines.join('\n');
}

export function registerMembershipTools(server: McpServer): void {
  // ── Get Memberships ───────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_memberships',
    {
      title: 'Search/List CiviCRM Memberships',
      description: `Search and list memberships in CiviCRM.

Args:
  - contact_id (number, optional): Filter by member contact ID
  - membership_type (string, optional): Filter by membership type label (e.g., "General", "Student")
  - status (string, optional): Filter by membership status (e.g., "Current", "Expired", "Pending")
  - date_from (string, optional): Filter memberships with end date on or after (YYYY-MM-DD)
  - date_to (string, optional): Filter memberships with end date on or before (YYYY-MM-DD)
  - limit (number, default 25, max 500): Maximum results
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of memberships with contact, type, status, and date information.`,
      inputSchema: z.object({
        contact_id: zOptionalId.describe('Filter by member contact ID'),
        membership_type: z.string().optional().describe('Membership type label (e.g., "General")'),
        status: z.string().optional().describe('Membership status (e.g., "Current", "Expired")'),
        date_from: z.string().optional().describe('End date on or after (YYYY-MM-DD)'),
        date_to: z.string().optional().describe('End date on or before (YYYY-MM-DD)'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ contact_id, membership_type, status, date_from, date_to, limit, offset, response_format }) => {
      try {
        const where: [string, string, unknown][] = [];
        if (contact_id) where.push(['contact_id', '=', contact_id]);
        if (membership_type) where.push(['membership_type_id:label', '=', membership_type]);
        if (status) where.push(['status_id:label', '=', status]);
        if (date_from) where.push(['end_date', '>=', date_from]);
        if (date_to) where.push(['end_date', '<=', date_to]);

        const result = await callCiviCRM('Membership', 'get', {
          select: ['id', 'contact_id', 'contact_id.display_name', 'membership_type_id:label',
            'status_id:label', 'start_date', 'end_date', 'join_date', 'source', 'is_override'],
          where,
          limit,
          offset,
          orderBy: { end_date: 'DESC' },
        });

        const memberships = result.values ?? [];
        const pagination = buildPagination(result.countMatched, memberships.length, offset, limit);

        if (memberships.length === 0) {
          return { content: [{ type: 'text', text: 'No memberships found matching the given criteria.' }] };
        }

        const output = { ...pagination, memberships };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# CiviCRM Memberships (${memberships.length} shown)`, ''];
          for (const m of memberships) {
            lines.push(formatMembershipMarkdown(m as Record<string, unknown>));
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

  // ── Create Membership ─────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_create_membership',
    {
      title: 'Create CiviCRM Membership',
      description: `Create a new membership record in CiviCRM.

Args:
  - contact_id (number): Member's contact ID
  - membership_type_id (string|number): Membership type label (e.g., "General") or numeric ID
  - join_date (string, optional): Date joined (YYYY-MM-DD, defaults to today)
  - start_date (string, optional): Membership start date (YYYY-MM-DD)
  - end_date (string, optional): Membership end date (YYYY-MM-DD)
  - status_id (string|number, optional): Status label (e.g., "Current") or ID
  - source (string, optional): Source of the membership
  - is_override (boolean, optional): Override automatic status calculation
  - additional_fields (object, optional): Additional membership fields

Returns:
  The created membership record with its new ID.`,
      inputSchema: z.object({
        contact_id: zId.describe('Member contact ID'),
        membership_type_id: z.union([z.string(), z.coerce.number()]).describe('Membership type label or ID'),
        join_date: z.string().optional().describe('Join date (YYYY-MM-DD)'),
        start_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        end_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
        status_id: z.union([z.string(), z.coerce.number()]).optional().describe('Status label or ID'),
        source: z.string().optional().describe('Source of the membership'),
        is_override: z.boolean().optional().describe('Override automatic status calculation'),
        additional_fields: z.record(z.unknown()).optional().describe('Additional membership fields'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ contact_id, membership_type_id, join_date, start_date, end_date,
      status_id, source, is_override, additional_fields }) => {
      try {
        const values: Record<string, unknown> = {
          contact_id,
          membership_type_id,
          ...additional_fields,
        };
        if (join_date) values['join_date'] = join_date;
        if (start_date) values['start_date'] = start_date;
        if (end_date) values['end_date'] = end_date;
        if (status_id !== undefined) values['status_id'] = status_id;
        if (source) values['source'] = source;
        if (is_override !== undefined) values['is_override'] = is_override;

        const result = await callCiviCRM('Membership', 'create', { values });
        const createdId = (result.values?.[0] as Record<string, unknown> | undefined)?.['id'];

        const fullResult = await callCiviCRM('Membership', 'get', {
          select: ['id', 'contact_id', 'contact_id.display_name', 'membership_type_id:label',
            'status_id:label', 'start_date', 'end_date', 'join_date'],
          where: [['id', '=', createdId]],
          limit: 1,
        });
        const membership = fullResult.values?.[0] ?? { id: createdId };

        return {
          content: [{ type: 'text', text: `Membership created successfully.\n\n${JSON.stringify(membership, null, 2)}` }],
          structuredContent: membership as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );
}
