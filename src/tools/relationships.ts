import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCiviCRM, handleToolError, truncateIfNeeded, buildPagination } from '../services/civicrm.js';
import { ResponseFormat } from '../types.js';
import { DEFAULT_LIMIT, MAX_LIMIT, zId, zOptionalId, zLimit, zOffset } from '../constants.js';

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

export function registerRelationshipTools(server: McpServer): void {
  // ── Get Relationships ─────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_relationships',
    {
      title: 'Search/List CiviCRM Relationships',
      description: `Search and list relationships between contacts in CiviCRM. Relationships link contacts (e.g., "Employee of", "Spouse of", "Member of").

Args:
  - contact_id (number, optional): Filter relationships involving this contact (as either side)
  - contact_id_a (number, optional): Filter by specific contact on side A
  - contact_id_b (number, optional): Filter by specific contact on side B
  - relationship_type (string, optional): Filter by relationship type label (e.g., "Employee of")
  - is_active (boolean, optional): Filter by active status (default: active only)
  - limit (number, default 25, max 500): Maximum results
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of relationships with both contacts, relationship type, and dates.`,
      inputSchema: z.object({
        contact_id: zOptionalId.describe('Contact involved in the relationship (either side)'),
        contact_id_a: zOptionalId.describe('Contact on side A of relationship'),
        contact_id_b: zOptionalId.describe('Contact on side B of relationship'),
        relationship_type: z.string().optional().describe('Relationship type label (e.g., "Employee of")'),
        is_active: z.boolean().optional().default(true).describe('Filter by active status (default: true)'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ contact_id, contact_id_a, contact_id_b, relationship_type, is_active, limit, offset, response_format }) => {
      try {
        const where: unknown[][] = [];
        if (is_active !== undefined) where.push(['is_active', '=', is_active]);
        if (relationship_type) where.push(['relationship_type_id:label_a_b', '=', relationship_type]);

        if (contact_id) {
          where.push(['OR', [
            ['contact_id_a', '=', contact_id],
            ['contact_id_b', '=', contact_id],
          ]]);
        }
        if (contact_id_a) where.push(['contact_id_a', '=', contact_id_a]);
        if (contact_id_b) where.push(['contact_id_b', '=', contact_id_b]);

        const result = await callCiviCRM('Relationship', 'get', {
          select: ['id', 'contact_id_a', 'contact_id_a.display_name', 'contact_id_b',
            'contact_id_b.display_name', 'relationship_type_id:label_a_b',
            'relationship_type_id:label_b_a', 'start_date', 'end_date', 'is_active',
            'description'],
          where,
          limit,
          offset,
          orderBy: { start_date: 'DESC' },
        });

        const relationships = result.values ?? [];
        const pagination = buildPagination(result.countMatched, relationships.length, offset, limit);

        if (relationships.length === 0) {
          return { content: [{ type: 'text', text: 'No relationships found matching the given criteria.' }] };
        }

        const output = { ...pagination, relationships };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# CiviCRM Relationships (${relationships.length} shown)`, ''];
          for (const r of relationships as Record<string, unknown>[]) {
            const nameA = r['contact_id_a.display_name'] ?? `Contact ${r['contact_id_a']}`;
            const nameB = r['contact_id_b.display_name'] ?? `Contact ${r['contact_id_b']}`;
            const relType = r['relationship_type_id:label_a_b'] ?? 'Related to';
            lines.push(`## ID: ${r['id']} — ${nameA} *${relType}* ${nameB}`);
            if (r['start_date']) lines.push(`- **Since**: ${r['start_date']}`);
            if (r['end_date']) lines.push(`- **Until**: ${r['end_date']}`);
            lines.push(`- **Active**: ${r['is_active'] ? 'Yes' : 'No'}`);
            if (r['description']) lines.push(`- **Notes**: ${r['description']}`);
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

  // ── Create Relationship ───────────────────────────────────────────────────
  server.registerTool(
    'civicrm_create_relationship',
    {
      title: 'Create CiviCRM Relationship',
      description: `Create a relationship between two contacts in CiviCRM.

Args:
  - contact_id_a (number): ID of the first contact (side A)
  - contact_id_b (number): ID of the second contact (side B)
  - relationship_type_id (string|number): Relationship type label (e.g., "Employee of") or numeric ID
  - start_date (string, optional): Relationship start date (YYYY-MM-DD, defaults to today)
  - end_date (string, optional): Relationship end date (YYYY-MM-DD)
  - description (string, optional): Optional notes about the relationship
  - is_active (boolean, default true): Is the relationship currently active

Note: Direction matters. "Contact A is Employee of Contact B" means contact_id_a is the employee, contact_id_b is the employer.
Use civicrm_get_entity_fields with entity="RelationshipType" to discover available relationship types.

Returns:
  The created relationship record with its new ID.`,
      inputSchema: z.object({
        contact_id_a: zId.describe('First contact ID (side A)'),
        contact_id_b: zId.describe('Second contact ID (side B)'),
        relationship_type_id: z.union([z.string(), z.coerce.number()]).describe('Relationship type label or ID'),
        start_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        end_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
        description: z.string().optional().describe('Notes about the relationship'),
        is_active: z.boolean().default(true).describe('Is the relationship active'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ contact_id_a, contact_id_b, relationship_type_id, start_date, end_date, description, is_active }) => {
      try {
        const values: Record<string, unknown> = {
          contact_id_a,
          contact_id_b,
          relationship_type_id,
          is_active,
        };
        if (start_date) values['start_date'] = start_date;
        if (end_date) values['end_date'] = end_date;
        if (description) values['description'] = description;

        const result = await callCiviCRM('Relationship', 'create', { values });
        const createdId = (result.values?.[0] as Record<string, unknown> | undefined)?.['id'];

        const fullResult = await callCiviCRM('Relationship', 'get', {
          select: ['id', 'contact_id_a', 'contact_id_a.display_name', 'contact_id_b',
            'contact_id_b.display_name', 'relationship_type_id:label_a_b', 'start_date', 'is_active'],
          where: [['id', '=', createdId]],
          limit: 1,
        });
        const relationship = fullResult.values?.[0] ?? { id: createdId };

        return {
          content: [{ type: 'text', text: `Relationship created successfully.\n\n${JSON.stringify(relationship, null, 2)}` }],
          structuredContent: relationship as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );
}
