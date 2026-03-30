import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCiviCRM, handleToolError, truncateIfNeeded, buildPagination } from '../services/civicrm.js';
import { ResponseFormat } from '../types.js';
import { DEFAULT_LIMIT, MAX_LIMIT, zId, zOptionalId, zLimit, zOffset } from '../constants.js';

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

function formatActivityMarkdown(a: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`## ${a['subject'] ?? '(No subject)'} (ID: ${a['id']})`);
  lines.push(`- **Type**: ${a['activity_type_id:label'] ?? a['activity_type_id'] ?? 'Unknown'}`);
  lines.push(`- **Status**: ${a['status_id:label'] ?? a['status_id'] ?? 'Unknown'}`);
  if (a['activity_date_time']) lines.push(`- **Date**: ${a['activity_date_time']}`);
  if (a['source_contact_id:label']) lines.push(`- **Created By**: ${a['source_contact_id:label']}`);
  if (a['details']) lines.push(`- **Details**: ${String(a['details']).slice(0, 200)}${String(a['details']).length > 200 ? '...' : ''}`);
  lines.push('');
  return lines.join('\n');
}

export function registerActivityTools(server: McpServer): void {
  // ── Get Activities ────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_activities',
    {
      title: 'Search/List CiviCRM Activities',
      description: `Search and list activities in CiviCRM. Activities represent interactions like calls, emails, meetings, and tasks.

Args:
  - contact_id (number, optional): Filter activities associated with a specific contact
  - activity_type (string, optional): Filter by activity type label (e.g., "Phone Call", "Email", "Meeting")
  - status (string, optional): Filter by status label (e.g., "Completed", "Scheduled", "Cancelled")
  - subject (string, optional): Filter by subject (partial match)
  - date_from (string, optional): Filter activities on or after this date (YYYY-MM-DD)
  - date_to (string, optional): Filter activities on or before this date (YYYY-MM-DD)
  - limit (number, default 25, max 500): Maximum results
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of activities with id, subject, type, status, date, and source contact.`,
      inputSchema: z.object({
        contact_id: zOptionalId.describe('Filter by associated contact ID'),
        activity_type: z.string().optional().describe('Filter by activity type label (e.g., "Phone Call")'),
        status: z.string().optional().describe('Filter by status label (e.g., "Completed")'),
        subject: z.string().optional().describe('Filter by subject (partial match)'),
        date_from: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
        date_to: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ contact_id, activity_type, status, subject, date_from, date_to, limit, offset, response_format }) => {
      try {
        const where: [string, string, unknown][] = [];
        if (activity_type) where.push(['activity_type_id:label', '=', activity_type]);
        if (status) where.push(['status_id:label', '=', status]);
        if (subject) where.push(['subject', 'LIKE', `%${subject}%`]);
        if (date_from) where.push(['activity_date_time', '>=', date_from]);
        if (date_to) where.push(['activity_date_time', '<=', `${date_to} 23:59:59`]);

        const params: Record<string, unknown> = {
          select: ['id', 'subject', 'activity_type_id:label', 'status_id:label',
            'activity_date_time', 'source_contact_id', 'source_contact_id:label', 'details'],
          where,
          limit,
          offset,
          orderBy: { activity_date_time: 'DESC' },
        };

        // If filtering by contact, use a join
        if (contact_id) {
          params['join'] = [['ActivityContact AS ac', 'INNER', null,
            ['ac.activity_id', '=', 'id'],
            ['ac.contact_id', '=', contact_id]]];
        }

        const result = await callCiviCRM('Activity', 'get', params);
        const activities = result.values ?? [];
        const pagination = buildPagination(result.countMatched, activities.length, offset, limit);

        if (activities.length === 0) {
          return { content: [{ type: 'text', text: 'No activities found matching the given criteria.' }] };
        }

        const output = { ...pagination, activities };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# CiviCRM Activities (${activities.length} shown)`, ''];
          for (const a of activities) {
            lines.push(formatActivityMarkdown(a as Record<string, unknown>));
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

  // ── Create Activity ───────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_create_activity',
    {
      title: 'Create CiviCRM Activity',
      description: `Create a new activity (interaction record) in CiviCRM.

Args:
  - activity_type_id (string|number): Activity type label (e.g., "Phone Call", "Email") or numeric ID
  - subject (string): Activity subject/title
  - activity_date_time (string, optional): Date and time (YYYY-MM-DD HH:MM:SS, defaults to now)
  - status_id (string|number, optional): Status label (e.g., "Completed", "Scheduled") or numeric ID (default: "Completed")
  - details (string, optional): Activity details/description
  - source_contact_id (number, optional): Contact ID of the person who initiated the activity
  - target_contact_id (number|number[], optional): Contact ID(s) of the activity target(s)
  - assignee_contact_id (number, optional): Contact ID of the person assigned to the activity
  - duration (number, optional): Duration in minutes
  - additional_fields (object, optional): Any additional CiviCRM activity fields

Returns:
  The created activity record with its new ID.`,
      inputSchema: z.object({
        activity_type_id: z.union([z.string(), z.coerce.number()]).describe('Activity type label or ID'),
        subject: z.string().min(1).describe('Activity subject/title'),
        activity_date_time: z.string().optional().describe('Date/time (YYYY-MM-DD HH:MM:SS)'),
        status_id: z.union([z.string(), z.coerce.number()]).default('Completed').describe('Status label or ID'),
        details: z.string().optional().describe('Activity details/description'),
        source_contact_id: zOptionalId.describe('Source contact ID'),
        target_contact_id: z.union([
          zId,
          z.array(zId),
        ]).optional().describe('Target contact ID(s)'),
        assignee_contact_id: zOptionalId.describe('Assignee contact ID'),
        duration: z.coerce.number().int().min(0).optional().describe('Duration in minutes'),
        additional_fields: z.record(z.unknown()).optional().describe('Additional activity fields'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ activity_type_id, subject, activity_date_time, status_id, details, source_contact_id,
      target_contact_id, assignee_contact_id, duration, additional_fields }) => {
      try {
        const values: Record<string, unknown> = {
          activity_type_id,
          subject,
          status_id,
          ...additional_fields,
        };
        if (activity_date_time) values['activity_date_time'] = activity_date_time;
        if (details) values['details'] = details;
        if (source_contact_id) values['source_contact_id'] = source_contact_id;
        if (target_contact_id !== undefined) {
          values['target_contact_id'] = Array.isArray(target_contact_id) ? target_contact_id : [target_contact_id];
        }
        if (assignee_contact_id) values['assignee_contact_id'] = [assignee_contact_id];
        if (duration !== undefined) values['duration'] = duration;

        const result = await callCiviCRM('Activity', 'create', { values });
        const createdId = (result.values?.[0] as Record<string, unknown> | undefined)?.['id'];

        const fullResult = await callCiviCRM('Activity', 'get', {
          select: ['id', 'subject', 'activity_type_id:label', 'status_id:label',
            'activity_date_time', 'source_contact_id:label', 'details'],
          where: [['id', '=', createdId]],
          limit: 1,
        });
        const activity = fullResult.values?.[0] ?? { id: createdId };

        return {
          content: [{ type: 'text', text: `Activity created successfully.\n\n${JSON.stringify(activity, null, 2)}` }],
          structuredContent: activity as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

  // ── Update Activity ───────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_update_activity',
    {
      title: 'Update CiviCRM Activity',
      description: `Update an existing CiviCRM activity by ID.

Args:
  - id (number): The activity ID to update
  - fields (object): Fields to update as key-value pairs

Returns:
  The updated activity record.`,
      inputSchema: z.object({
        id: zId.describe('Activity ID to update'),
        fields: z.record(z.unknown()).describe('Fields to update (e.g., {"status_id": "Completed", "details": "..."})'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, fields }) => {
      try {
        await callCiviCRM('Activity', 'update', {
          values: fields,
          where: [['id', '=', id]],
        });

        const fullResult = await callCiviCRM('Activity', 'get', {
          select: ['id', 'subject', 'activity_type_id:label', 'status_id:label',
            'activity_date_time', 'source_contact_id:label', 'details'],
          where: [['id', '=', id]],
          limit: 1,
        });
        const activity = fullResult.values?.[0] ?? { id };

        return {
          content: [{ type: 'text', text: `Activity ${id} updated successfully.\n\n${JSON.stringify(activity, null, 2)}` }],
          structuredContent: activity as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );
}
