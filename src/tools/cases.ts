import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCiviCRM, handleToolError, truncateIfNeeded, buildPagination } from '../services/civicrm.js';
import { ResponseFormat } from '../types.js';
import { DEFAULT_LIMIT, MAX_LIMIT, zId, zOptionalId, zLimit, zOffset } from '../constants.js';

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

export function registerCaseTools(server: McpServer): void {
  // ── Get Cases ─────────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_cases',
    {
      title: 'Search/List CiviCRM Cases',
      description: `Search and list cases in CiviCRM. Cases track ongoing client interactions, services, or issues (requires CiviCase component).

Args:
  - contact_id (number, optional): Filter cases involving a specific contact
  - case_type (string, optional): Filter by case type label (e.g., "Housing Support", "General")
  - status (string, optional): Filter by case status (e.g., "Open", "Closed", "Urgent")
  - subject (string, optional): Filter by case subject (partial match)
  - is_deleted (boolean, optional): Include deleted cases (default: false)
  - limit (number, default 25, max 500): Maximum results
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of cases with id, subject, type, status, contact, and dates.`,
      inputSchema: z.object({
        contact_id: zOptionalId.describe('Filter by client contact ID'),
        case_type: z.string().optional().describe('Case type label (e.g., "Housing Support")'),
        status: z.string().optional().describe('Case status (e.g., "Open", "Closed")'),
        subject: z.string().optional().describe('Filter by subject (partial match)'),
        is_deleted: z.boolean().default(false).describe('Include deleted cases'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ contact_id, case_type, status, subject, is_deleted, limit, offset, response_format }) => {
      try {
        const where: [string, string, unknown][] = [
          ['is_deleted', '=', is_deleted],
        ];
        if (case_type) where.push(['case_type_id:label', '=', case_type]);
        if (status) where.push(['status_id:label', '=', status]);
        if (subject) where.push(['subject', 'LIKE', `%${subject}%`]);

        const params: Record<string, unknown> = {
          select: ['id', 'subject', 'case_type_id:label', 'status_id:label',
            'start_date', 'end_date', 'is_deleted', 'details'],
          where,
          limit,
          offset,
          orderBy: { start_date: 'DESC' },
        };

        if (contact_id) {
          params['join'] = [['CaseContact AS cc', 'INNER', null,
            ['cc.case_id', '=', 'id'],
            ['cc.contact_id', '=', contact_id]]];
        }

        const result = await callCiviCRM('Case', 'get', params);
        const cases = result.values ?? [];
        const pagination = buildPagination(result.countMatched, cases.length, offset, limit);

        if (cases.length === 0) {
          return { content: [{ type: 'text', text: 'No cases found matching the given criteria.' }] };
        }

        const output = { ...pagination, cases };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# CiviCRM Cases (${cases.length} shown)`, ''];
          for (const c of cases as Record<string, unknown>[]) {
            lines.push(`## ${c['subject'] ?? '(No subject)'} (ID: ${c['id']})`);
            lines.push(`- **Type**: ${c['case_type_id:label'] ?? 'Unknown'}`);
            lines.push(`- **Status**: ${c['status_id:label'] ?? 'Unknown'}`);
            if (c['start_date']) lines.push(`- **Start**: ${c['start_date']}`);
            if (c['end_date']) lines.push(`- **End**: ${c['end_date']}`);
            if (c['details']) {
              const details = String(c['details']).slice(0, 200);
              lines.push(`- **Details**: ${details}${String(c['details']).length > 200 ? '...' : ''}`);
            }
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

  // ── Create Case ───────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_create_case',
    {
      title: 'Create CiviCRM Case',
      description: `Create a new case in CiviCRM (requires CiviCase component).

Args:
  - contact_id (number): Client contact ID (the person the case is about)
  - case_type_id (string|number): Case type label (e.g., "Housing Support") or numeric ID
  - subject (string): Case subject/title
  - start_date (string, optional): Case start date (YYYY-MM-DD, defaults to today)
  - status_id (string|number, optional): Status label (e.g., "Open") or ID (default: "Open")
  - details (string, optional): Case description/details
  - additional_fields (object, optional): Additional case fields

Returns:
  The created case record with its new ID.`,
      inputSchema: z.object({
        contact_id: zId.describe('Client contact ID'),
        case_type_id: z.union([z.string(), z.coerce.number()]).describe('Case type label or ID'),
        subject: z.string().min(1).describe('Case subject/title'),
        start_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        status_id: z.union([z.string(), z.coerce.number()]).default('Open').describe('Status label or ID'),
        details: z.string().optional().describe('Case description/details'),
        additional_fields: z.record(z.unknown()).optional().describe('Additional case fields'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ contact_id, case_type_id, subject, start_date, status_id, details, additional_fields }) => {
      try {
        const values: Record<string, unknown> = {
          contact_id,
          case_type_id,
          subject,
          status_id,
          ...additional_fields,
        };
        if (start_date) values['start_date'] = start_date;
        if (details) values['details'] = details;

        const result = await callCiviCRM('Case', 'create', { values });
        const createdId = (result.values?.[0] as Record<string, unknown> | undefined)?.['id'];

        const fullResult = await callCiviCRM('Case', 'get', {
          select: ['id', 'subject', 'case_type_id:label', 'status_id:label', 'start_date', 'details'],
          where: [['id', '=', createdId]],
          limit: 1,
        });
        const caseRecord = fullResult.values?.[0] ?? { id: createdId };

        return {
          content: [{ type: 'text', text: `Case created successfully.\n\n${JSON.stringify(caseRecord, null, 2)}` }],
          structuredContent: caseRecord as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );
}
