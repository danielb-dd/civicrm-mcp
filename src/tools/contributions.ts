import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCiviCRM, handleToolError, truncateIfNeeded, buildPagination } from '../services/civicrm.js';
import { ResponseFormat } from '../types.js';
import { DEFAULT_LIMIT, MAX_LIMIT, zId, zOptionalId, zLimit, zOffset } from '../constants.js';

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

function formatContributionMarkdown(c: Record<string, unknown>): string {
  const lines: string[] = [];
  const name = c['contact_id.display_name'] ?? c['contact_id'] ?? 'Unknown';
  const email = c['contact_id.email_primary.email'];
  lines.push(`## Contribution ID: ${c['id']}`);
  lines.push(`- **Contact**: ${name} (ID: ${c['contact_id']})${email ? ` — ${email}` : ''}`);
  if (c['contact_id.first_name'] || c['contact_id.last_name']) {
    lines.push(`- **Name**: ${c['contact_id.first_name'] ?? ''} ${c['contact_id.last_name'] ?? ''}`.trim());
  }
  lines.push(`- **Amount**: ${c['currency'] ?? 'USD'} ${c['total_amount']}`);
  lines.push(`- **Financial Type**: ${c['financial_type_id:label'] ?? 'Unknown'}`);
  lines.push(`- **Status**: ${c['contribution_status_id:label'] ?? 'Unknown'}`);
  if (c['receive_date']) lines.push(`- **Received**: ${c['receive_date']}`);
  if (c['source']) lines.push(`- **Source**: ${c['source']}`);
  if (c['trxn_id']) lines.push(`- **Transaction ID**: ${c['trxn_id']}`);
  if (c['invoice_id']) lines.push(`- **Invoice ID**: ${c['invoice_id']}`);
  lines.push('');
  return lines.join('\n');
}

export function registerContributionTools(server: McpServer): void {
  // ── Get Contributions ─────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_contributions',
    {
      title: 'Search/List CiviCRM Contributions',
      description: `Search and list contributions (donations, payments) in CiviCRM.

Args:
  - contact_id (number, optional): Filter by donor contact ID
  - financial_type (string, optional): Filter by financial type label (e.g., "Donation", "Member Dues")
  - status (string, optional): Filter by contribution status (e.g., "Completed", "Pending", "Failed")
  - amount_min (number, optional): Minimum total amount
  - amount_max (number, optional): Maximum total amount
  - date_from (string, optional): Filter contributions received on or after (YYYY-MM-DD)
  - date_to (string, optional): Filter contributions received on or before (YYYY-MM-DD)
  - limit (number, default 25, max 500): Maximum results
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of contributions with contact, amount, type, status, and date.`,
      inputSchema: z.object({
        contact_id: zOptionalId.describe('Filter by donor contact ID'),
        financial_type: z.string().optional().describe('Financial type label (e.g., "Donation")'),
        status: z.string().optional().describe('Contribution status (e.g., "Completed")'),
        amount_min: z.coerce.number().optional().describe('Minimum total amount'),
        amount_max: z.coerce.number().optional().describe('Maximum total amount'),
        date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ contact_id, financial_type, status, amount_min, amount_max, date_from, date_to, limit, offset, response_format }) => {
      try {
        const where: [string, string, unknown][] = [];
        if (contact_id) where.push(['contact_id', '=', contact_id]);
        if (financial_type) where.push(['financial_type_id:label', '=', financial_type]);
        if (status) where.push(['contribution_status_id:label', '=', status]);
        if (amount_min !== undefined) where.push(['total_amount', '>=', amount_min]);
        if (amount_max !== undefined) where.push(['total_amount', '<=', amount_max]);
        if (date_from) where.push(['receive_date', '>=', date_from]);
        if (date_to) where.push(['receive_date', '<=', `${date_to} 23:59:59`]);

        const result = await callCiviCRM('Contribution', 'get', {
          select: [
            'id', 'contact_id',
            'contact_id.display_name', 'contact_id.first_name', 'contact_id.last_name',
            'contact_id.email_primary.email',
            'financial_type_id:label', 'total_amount', 'currency', 'receive_date',
            'contribution_status_id:label', 'source', 'trxn_id', 'invoice_id',
          ],
          where,
          limit,
          offset,
          orderBy: { receive_date: 'DESC' },
        });

        const contributions = result.values ?? [];
        const pagination = buildPagination(result.countMatched, contributions.length, offset, limit);

        if (contributions.length === 0) {
          return { content: [{ type: 'text', text: 'No contributions found matching the given criteria.' }] };
        }

        const output = { ...pagination, contributions };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const totalAmount = contributions.reduce((sum, c) => sum + (Number((c as Record<string, unknown>)['total_amount']) || 0), 0);
          const lines = [
            `# CiviCRM Contributions (${contributions.length} shown, total: ${totalAmount.toFixed(2)})`,
            '',
          ];
          for (const c of contributions) {
            lines.push(formatContributionMarkdown(c as Record<string, unknown>));
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

  // ── Create Contribution ───────────────────────────────────────────────────
  server.registerTool(
    'civicrm_create_contribution',
    {
      title: 'Create CiviCRM Contribution',
      description: `Record a new contribution (donation/payment) in CiviCRM.

Args:
  - contact_id (number): Donor's contact ID
  - financial_type_id (string|number): Financial type label (e.g., "Donation") or numeric ID
  - total_amount (number): Contribution amount
  - currency (string, default 'USD'): ISO currency code (e.g., "USD", "EUR", "GBP")
  - receive_date (string, optional): Date received (YYYY-MM-DD, defaults to today)
  - contribution_status_id (string|number, optional): Status label (e.g., "Completed") or ID (default: "Completed")
  - source (string, optional): Source description
  - trxn_id (string, optional): External transaction ID
  - note (string, optional): Internal note
  - additional_fields (object, optional): Additional contribution fields

Returns:
  The created contribution record with its new ID.`,
      inputSchema: z.object({
        contact_id: zId.describe('Donor contact ID'),
        financial_type_id: z.union([z.string(), z.coerce.number()]).describe('Financial type label or ID'),
        total_amount: z.coerce.number().positive().describe('Contribution amount'),
        currency: z.string().length(3).default('USD').describe('ISO currency code'),
        receive_date: z.string().optional().describe('Date received (YYYY-MM-DD)'),
        contribution_status_id: z.union([z.string(), z.coerce.number()]).default('Completed').describe('Status label or ID'),
        source: z.string().optional().describe('Source description'),
        trxn_id: z.string().optional().describe('External transaction ID'),
        note: z.string().optional().describe('Internal note'),
        additional_fields: z.record(z.unknown()).optional().describe('Additional contribution fields'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ contact_id, financial_type_id, total_amount, currency, receive_date,
      contribution_status_id, source, trxn_id, note, additional_fields }) => {
      try {
        const values: Record<string, unknown> = {
          contact_id,
          financial_type_id,
          total_amount,
          currency,
          contribution_status_id,
          ...additional_fields,
        };
        if (receive_date) values['receive_date'] = receive_date;
        if (source) values['source'] = source;
        if (trxn_id) values['trxn_id'] = trxn_id;
        if (note) values['note'] = note;

        const result = await callCiviCRM('Contribution', 'create', { values });
        const createdId = (result.values?.[0] as Record<string, unknown> | undefined)?.['id'];

        const fullResult = await callCiviCRM('Contribution', 'get', {
          select: ['id', 'contact_id', 'contact_id.display_name', 'contact_id.first_name',
            'contact_id.last_name', 'contact_id.email_primary.email',
            'financial_type_id:label', 'total_amount', 'currency', 'receive_date',
            'contribution_status_id:label', 'source', 'trxn_id'],
          where: [['id', '=', createdId]],
          limit: 1,
        });
        const contribution = fullResult.values?.[0] ?? { id: createdId };

        return {
          content: [{ type: 'text', text: `Contribution created successfully.\n\n${JSON.stringify(contribution, null, 2)}` }],
          structuredContent: contribution as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

  // ── Update Contribution ───────────────────────────────────────────────────
  server.registerTool(
    'civicrm_update_contribution',
    {
      title: 'Update CiviCRM Contribution',
      description: `Update an existing CiviCRM contribution by ID.

Args:
  - id (number): The contribution ID to update
  - fields (object): Fields to update as key-value pairs

Returns:
  The updated contribution record.`,
      inputSchema: z.object({
        id: zId.describe('Contribution ID to update'),
        fields: z.record(z.unknown()).describe('Fields to update (e.g., {"contribution_status_id": "Completed"})'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, fields }) => {
      try {
        await callCiviCRM('Contribution', 'update', {
          values: fields,
          where: [['id', '=', id]],
        });

        const fullResult = await callCiviCRM('Contribution', 'get', {
          select: ['id', 'contact_id', 'contact_id.display_name', 'contact_id.first_name',
            'contact_id.last_name', 'contact_id.email_primary.email',
            'financial_type_id:label', 'total_amount', 'currency', 'receive_date',
            'contribution_status_id:label', 'source'],
          where: [['id', '=', id]],
          limit: 1,
        });
        const contribution = fullResult.values?.[0] ?? { id };

        return {
          content: [{ type: 'text', text: `Contribution ${id} updated successfully.\n\n${JSON.stringify(contribution, null, 2)}` }],
          structuredContent: contribution as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );
}
