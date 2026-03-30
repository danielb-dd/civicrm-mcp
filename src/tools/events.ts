import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCiviCRM, handleToolError, truncateIfNeeded, buildPagination } from '../services/civicrm.js';
import { ResponseFormat } from '../types.js';
import { DEFAULT_LIMIT, MAX_LIMIT, zId, zOptionalId, zLimit, zOffset } from '../constants.js';

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

function formatEventMarkdown(e: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`## ${e['title']} (ID: ${e['id']})`);
  lines.push(`- **Type**: ${e['event_type_id:label'] ?? e['event_type_id'] ?? 'Unknown'}`);
  if (e['start_date']) lines.push(`- **Start**: ${e['start_date']}`);
  if (e['end_date']) lines.push(`- **End**: ${e['end_date']}`);
  if (e['max_participants']) lines.push(`- **Max Participants**: ${e['max_participants']}`);
  if (e['is_online_registration']) lines.push(`- **Online Registration**: Yes`);
  lines.push(`- **Active**: ${e['is_active'] ? 'Yes' : 'No'}`);
  if (e['description']) {
    const desc = String(e['description']).slice(0, 200);
    lines.push(`- **Description**: ${desc}${String(e['description']).length > 200 ? '...' : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatParticipantMarkdown(p: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`## ${p['contact_id.display_name'] ?? `Contact ${p['contact_id']}`} (Participant ID: ${p['id']})`);
  lines.push(`- **Status**: ${p['status_id:label'] ?? p['status_id'] ?? 'Unknown'}`);
  lines.push(`- **Role**: ${p['role_id:label'] ?? p['role_id'] ?? 'Unknown'}`);
  if (p['register_date']) lines.push(`- **Registered**: ${p['register_date']}`);
  if (p['fee_amount']) lines.push(`- **Fee**: ${p['fee_currency'] ?? 'USD'} ${p['fee_amount']}`);
  lines.push('');
  return lines.join('\n');
}

export function registerEventTools(server: McpServer): void {
  // ── Get Events ────────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_events',
    {
      title: 'Search/List CiviCRM Events',
      description: `Search and list events in CiviCRM.

Args:
  - title (string, optional): Filter by event title (partial match)
  - event_type (string, optional): Filter by event type label (e.g., "Conference", "Fundraiser")
  - is_active (boolean, optional): Filter by active status (default: shows all)
  - date_from (string, optional): Events starting on or after this date (YYYY-MM-DD)
  - date_to (string, optional): Events starting on or before this date (YYYY-MM-DD)
  - limit (number, default 25, max 500): Maximum results
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of events with id, title, type, dates, and registration info.`,
      inputSchema: z.object({
        title: z.string().optional().describe('Filter by event title (partial match)'),
        event_type: z.string().optional().describe('Event type label (e.g., "Conference")'),
        is_active: z.boolean().optional().describe('Filter by active status'),
        date_from: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
        date_to: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ title, event_type, is_active, date_from, date_to, limit, offset, response_format }) => {
      try {
        const where: [string, string, unknown][] = [];
        if (title) where.push(['title', 'LIKE', `%${title}%`]);
        if (event_type) where.push(['event_type_id:label', '=', event_type]);
        if (is_active !== undefined) where.push(['is_active', '=', is_active]);
        if (date_from) where.push(['start_date', '>=', date_from]);
        if (date_to) where.push(['start_date', '<=', `${date_to} 23:59:59`]);

        const result = await callCiviCRM('Event', 'get', {
          select: ['id', 'title', 'event_type_id:label', 'start_date', 'end_date',
            'is_active', 'max_participants', 'is_online_registration', 'description',
            'is_public', 'is_monetary'],
          where,
          limit,
          offset,
          orderBy: { start_date: 'DESC' },
        });

        const events = result.values ?? [];
        const pagination = buildPagination(result.countMatched, events.length, offset, limit);

        if (events.length === 0) {
          return { content: [{ type: 'text', text: 'No events found matching the given criteria.' }] };
        }

        const output = { ...pagination, events };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [`# CiviCRM Events (${events.length} shown)`, ''];
          for (const e of events) {
            lines.push(formatEventMarkdown(e as Record<string, unknown>));
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

  // ── Create Event ──────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_create_event',
    {
      title: 'Create CiviCRM Event',
      description: `Create a new event in CiviCRM.

Args:
  - title (string): Event title
  - event_type_id (string|number): Event type label (e.g., "Conference") or numeric ID
  - start_date (string): Event start date/time (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)
  - end_date (string, optional): Event end date/time
  - description (string, optional): Event description
  - max_participants (number, optional): Maximum number of participants
  - is_online_registration (boolean, optional): Allow online registration
  - is_public (boolean, optional): Show on public calendar
  - is_active (boolean, default true): Is the event active
  - additional_fields (object, optional): Additional event fields

Returns:
  The created event record with its new ID.`,
      inputSchema: z.object({
        title: z.string().min(1).describe('Event title'),
        event_type_id: z.union([z.string(), z.coerce.number()]).describe('Event type label or ID'),
        start_date: z.string().describe('Start date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)'),
        end_date: z.string().optional().describe('End date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)'),
        description: z.string().optional().describe('Event description'),
        max_participants: zOptionalId.describe('Max participants'),
        is_online_registration: z.boolean().optional().describe('Allow online registration'),
        is_public: z.boolean().optional().describe('Show on public calendar'),
        is_active: z.boolean().default(true).describe('Is the event active'),
        additional_fields: z.record(z.unknown()).optional().describe('Additional event fields'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ title, event_type_id, start_date, end_date, description, max_participants,
      is_online_registration, is_public, is_active, additional_fields }) => {
      try {
        const values: Record<string, unknown> = {
          title,
          event_type_id,
          start_date,
          is_active,
          ...additional_fields,
        };
        if (end_date) values['end_date'] = end_date;
        if (description) values['description'] = description;
        if (max_participants !== undefined) values['max_participants'] = max_participants;
        if (is_online_registration !== undefined) values['is_online_registration'] = is_online_registration;
        if (is_public !== undefined) values['is_public'] = is_public;

        const result = await callCiviCRM('Event', 'create', { values });
        const createdId = (result.values?.[0] as Record<string, unknown> | undefined)?.['id'];

        const fullResult = await callCiviCRM('Event', 'get', {
          select: ['id', 'title', 'event_type_id:label', 'start_date', 'end_date',
            'is_active', 'max_participants', 'is_online_registration'],
          where: [['id', '=', createdId]],
          limit: 1,
        });
        const event = fullResult.values?.[0] ?? { id: createdId };

        return {
          content: [{ type: 'text', text: `Event created successfully.\n\n${JSON.stringify(event, null, 2)}` }],
          structuredContent: event as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

  // ── Get Participants ──────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_participants',
    {
      title: 'Get CiviCRM Event Participants',
      description: `Get participants registered for an event in CiviCRM.

Args:
  - event_id (number, optional): Filter by event ID
  - contact_id (number, optional): Filter by participant contact ID
  - status (string, optional): Filter by participant status (e.g., "Registered", "Attended", "Cancelled")
  - limit (number, default 25, max 500): Maximum results
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of participants with contact info, registration status, and fee details.`,
      inputSchema: z.object({
        event_id: zOptionalId.describe('Filter by event ID'),
        contact_id: zOptionalId.describe('Filter by contact ID'),
        status: z.string().optional().describe('Participant status (e.g., "Registered")'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ event_id, contact_id, status, limit, offset, response_format }) => {
      try {
        const where: [string, string, unknown][] = [];
        if (event_id) where.push(['event_id', '=', event_id]);
        if (contact_id) where.push(['contact_id', '=', contact_id]);
        if (status) where.push(['status_id:label', '=', status]);

        const result = await callCiviCRM('Participant', 'get', {
          select: ['id', 'contact_id', 'contact_id.display_name', 'event_id', 'event_id.title',
            'status_id:label', 'role_id:label', 'register_date', 'fee_amount', 'fee_currency',
            'must_wait'],
          where,
          limit,
          offset,
          orderBy: { register_date: 'DESC' },
        });

        const participants = result.values ?? [];
        const pagination = buildPagination(result.countMatched, participants.length, offset, limit);

        if (participants.length === 0) {
          return { content: [{ type: 'text', text: 'No participants found matching the given criteria.' }] };
        }

        const output = { ...pagination, participants };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const eventTitle = (participants[0] as Record<string, unknown>)?.['event_id.title'];
          const lines = [
            `# Participants${eventTitle ? ` for "${eventTitle}"` : ''} (${participants.length} shown)`,
            '',
          ];
          for (const p of participants) {
            lines.push(formatParticipantMarkdown(p as Record<string, unknown>));
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

  // ── Create Participant ────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_create_participant',
    {
      title: 'Register CiviCRM Event Participant',
      description: `Register a contact as a participant in a CiviCRM event.

Args:
  - contact_id (number): Contact ID of the participant
  - event_id (number): Event ID to register for
  - status_id (string|number, optional): Participant status label (e.g., "Registered") or ID (default: "Registered")
  - role_id (string|number, optional): Participant role label (e.g., "Attendee") or ID (default: "Attendee")
  - register_date (string, optional): Registration date (YYYY-MM-DD, defaults to today)
  - fee_amount (number, optional): Fee paid
  - fee_currency (string, optional): Fee currency code (default: "USD")
  - additional_fields (object, optional): Additional participant fields

Returns:
  The created participant record with its new ID.`,
      inputSchema: z.object({
        contact_id: zId.describe('Contact ID to register'),
        event_id: zId.describe('Event ID'),
        status_id: z.union([z.string(), z.coerce.number()]).default('Registered').describe('Participant status'),
        role_id: z.union([z.string(), z.coerce.number()]).default('Attendee').describe('Participant role'),
        register_date: z.string().optional().describe('Registration date (YYYY-MM-DD)'),
        fee_amount: z.coerce.number().min(0).optional().describe('Fee amount paid'),
        fee_currency: z.string().length(3).optional().describe('Fee currency code'),
        additional_fields: z.record(z.unknown()).optional().describe('Additional participant fields'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ contact_id, event_id, status_id, role_id, register_date, fee_amount, fee_currency, additional_fields }) => {
      try {
        const values: Record<string, unknown> = {
          contact_id,
          event_id,
          status_id,
          role_id,
          ...additional_fields,
        };
        if (register_date) values['register_date'] = register_date;
        if (fee_amount !== undefined) values['fee_amount'] = fee_amount;
        if (fee_currency) values['fee_currency'] = fee_currency;

        const result = await callCiviCRM('Participant', 'create', { values });
        const createdId = (result.values?.[0] as Record<string, unknown> | undefined)?.['id'];

        const fullResult = await callCiviCRM('Participant', 'get', {
          select: ['id', 'contact_id', 'contact_id.display_name', 'event_id', 'event_id.title',
            'status_id:label', 'role_id:label', 'register_date', 'fee_amount'],
          where: [['id', '=', createdId]],
          limit: 1,
        });
        const participant = fullResult.values?.[0] ?? { id: createdId };

        return {
          content: [{ type: 'text', text: `Participant registered successfully.\n\n${JSON.stringify(participant, null, 2)}` }],
          structuredContent: participant as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );
}
