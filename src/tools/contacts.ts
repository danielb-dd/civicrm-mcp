import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCiviCRM, handleToolError, truncateIfNeeded, buildPagination } from '../services/civicrm.js';
import { ResponseFormat } from '../types.js';
import { DEFAULT_LIMIT, MAX_LIMIT, zId, zOptionalId, zLimit, zOffset } from '../constants.js';

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

function formatContactMarkdown(contact: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`## ${contact['display_name'] ?? 'Unknown'} (ID: ${contact['id']})`);
  lines.push(`- **Type**: ${contact['contact_type']} ${contact['contact_sub_type'] ? `(${JSON.stringify(contact['contact_sub_type'])})` : ''}`);
  if (contact['first_name'] || contact['last_name']) {
    lines.push(`- **Name**: ${contact['first_name'] ?? ''} ${contact['last_name'] ?? ''}`.trim());
  }
  if (contact['organization_name']) lines.push(`- **Organization**: ${contact['organization_name']}`);
  const email = (contact['email_primary'] as Record<string, unknown>)?.['email'];
  if (email) lines.push(`- **Email**: ${email}`);
  const phone = (contact['phone_primary'] as Record<string, unknown>)?.['phone'];
  if (phone) lines.push(`- **Phone**: ${phone}`);
  const addr = contact['address_primary'] as Record<string, unknown> | undefined;
  if (addr?.['street_address']) {
    lines.push(`- **Address**: ${addr['street_address']}, ${addr['city'] ?? ''} ${addr['postal_code'] ?? ''}`);
  }
  if (contact['is_deleted']) lines.push(`- **Status**: Deleted`);
  lines.push('');
  return lines.join('\n');
}

export function registerContactTools(server: McpServer): void {
  // ── Get Contacts ──────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_contacts',
    {
      title: 'Search/List CiviCRM Contacts',
      description: `Search and list contacts in CiviCRM. Supports filtering by name, email, contact type, and any contact field.

Args:
  - search (string, optional): Search by display name (partial match)
  - last_name (string, optional): Filter by last name (partial match — use this for "find all Smiths")
  - contact_type ('Individual'|'Organization'|'Household', optional): Filter by contact type
  - email (string, optional): Filter by exact or partial email address
  - limit (number, default 25, max 500): Maximum results to return
  - offset (number, default 0): Pagination offset
  - response_format ('markdown'|'json'): Output format

Returns:
  List of contacts with id, display_name, contact_type, email, phone, address, and pagination metadata.

Examples:
  - Find all contacts with last name Smith: last_name="Smith"
  - Find all organizations named "ACME": search="ACME", contact_type="Organization"
  - Find contacts with gmail: email="gmail.com"
  - Page 2 of all individuals: contact_type="Individual", limit=25, offset=25`,
      inputSchema: z.object({
        search: z.string().optional().describe('Search by display name, first name, last name, or organization name (partial match)'),
        last_name: z.string().optional().describe('Filter by exact or partial last name (e.g., "Smith")'),
        contact_type: z
          .enum(['Individual', 'Organization', 'Household'])
          .optional()
          .describe('Filter by contact type'),
        email: z.string().optional().describe('Filter by email address (partial match)'),
        limit: zLimit.describe("Max results (default 25, max 500)"),
        offset: zOffset.describe('Pagination offset'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ search, last_name, contact_type, email, limit, offset, response_format }) => {
      try {
        const where: unknown[][] = [['is_deleted', '=', false]];
        if (contact_type) where.push(['contact_type', '=', contact_type]);
        if (last_name) where.push(['last_name', 'LIKE', `%${last_name}%`]);
        if (search) where.push(['display_name', 'LIKE', `%${search}%`]);
        if (email) where.push(['email_primary.email', 'LIKE', `%${email}%`]);

        const result = await callCiviCRM('Contact', 'get', {
          select: ['id', 'display_name', 'contact_type', 'contact_sub_type', 'first_name', 'last_name',
            'organization_name', 'email_primary.email', 'phone_primary.phone',
            'address_primary.street_address', 'address_primary.city', 'address_primary.postal_code'],
          where,
          limit,
          offset,
          orderBy: { display_name: 'ASC' },
        });

        const contacts = result.values ?? [];
        const pagination = buildPagination(result.countMatched, contacts.length, offset, limit);

        if (contacts.length === 0) {
          return { content: [{ type: 'text', text: 'No contacts found matching the given criteria.' }] };
        }

        const output = { ...pagination, contacts };

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [
            `# CiviCRM Contacts (${contacts.length} shown${pagination.total !== null ? `, ${pagination.total} total` : ''})`,
            '',
          ];
          for (const c of contacts) {
            lines.push(formatContactMarkdown(c as Record<string, unknown>));
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

  // ── Get Contact by ID ─────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_contact',
    {
      title: 'Get CiviCRM Contact by ID',
      description: `Retrieve a single contact record by its numeric ID with full details including emails, phones, addresses, and custom fields.

Args:
  - id (number): The CiviCRM contact ID
  - include_custom (boolean, default false): Include all custom field data
  - response_format ('markdown'|'json'): Output format

Returns:
  Full contact record including all standard fields, emails, phones, and addresses.

Examples:
  - Get contact 42 with all details: id=42
  - Get contact with custom fields: id=42, include_custom=true`,
      inputSchema: z.object({
        id: zId.describe('CiviCRM contact ID'),
        include_custom: z
          .boolean()
          .default(false)
          .describe('Include custom field data (may be slow)'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, include_custom, response_format }) => {
      try {
        const select = [
          'id', 'display_name', 'contact_type', 'contact_sub_type', 'first_name', 'last_name',
          'middle_name', 'organization_name', 'nick_name', 'external_identifier',
          'job_title', 'gender_id:label', 'birth_date', 'deceased_date',
          'preferred_communication_method:label', 'do_not_email', 'do_not_phone', 'do_not_mail',
          'do_not_sms', 'do_not_trade', 'is_opt_out',
          'email_primary.email', 'email_primary.is_primary',
          'phone_primary.phone', 'phone_primary.phone_type_id:label',
          'address_primary.street_address', 'address_primary.city',
          'address_primary.state_province_id:label', 'address_primary.postal_code',
          'address_primary.country_id:label',
          'created_date', 'modified_date', 'is_deleted',
        ];
        if (include_custom) select.push('custom.*');

        const result = await callCiviCRM('Contact', 'get', {
          select,
          where: [['id', '=', id]],
          limit: 1,
        });

        const contact = result.values?.[0];
        if (!contact) {
          return { content: [{ type: 'text', text: `No contact found with ID ${id}.` }] };
        }

        let text: string;
        if (response_format === ResponseFormat.JSON) {
          text = JSON.stringify(contact, null, 2);
        } else {
          text = formatContactMarkdown(contact as Record<string, unknown>);
          // Add extra fields
          const extra: string[] = [];
          if (contact['job_title']) extra.push(`- **Job Title**: ${contact['job_title']}`);
          if (contact['birth_date']) extra.push(`- **Birth Date**: ${contact['birth_date']}`);
          if (contact['do_not_email']) extra.push(`- **Do Not Email**: Yes`);
          if (contact['is_opt_out']) extra.push(`- **Opted Out**: Yes`);
          if (contact['created_date']) extra.push(`- **Created**: ${contact['created_date']}`);
          if (contact['modified_date']) extra.push(`- **Modified**: ${contact['modified_date']}`);
          if (extra.length) text += extra.join('\n') + '\n';
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent: contact as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

  // ── Create Contact ────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_create_contact',
    {
      title: 'Create CiviCRM Contact',
      description: `Create a new contact in CiviCRM.

Args:
  - contact_type ('Individual'|'Organization'|'Household'): Type of contact
  - first_name (string, optional): First name (for individuals)
  - last_name (string, optional): Last name (for individuals)
  - organization_name (string, optional): Organization name (for organizations/households)
  - email (string, optional): Primary email address
  - phone (string, optional): Primary phone number
  - job_title (string, optional): Job title
  - external_identifier (string, optional): External system ID for de-duplication
  - additional_fields (object, optional): Any additional CiviCRM contact fields as key-value pairs

Returns:
  The created contact record with its new ID.

Examples:
  - Create individual: contact_type="Individual", first_name="Jane", last_name="Doe", email="jane@example.com"
  - Create org: contact_type="Organization", organization_name="ACME Corp"`,
      inputSchema: z.object({
        contact_type: z
          .enum(['Individual', 'Organization', 'Household'])
          .describe('Type of contact'),
        first_name: z.string().optional().describe('First name (individuals only)'),
        last_name: z.string().optional().describe('Last name (individuals only)'),
        organization_name: z.string().optional().describe('Organization name (organizations/households)'),
        email: z.string().email().optional().describe('Primary email address'),
        phone: z.string().optional().describe('Primary phone number'),
        job_title: z.string().optional().describe('Job title'),
        external_identifier: z.string().optional().describe('External system identifier'),
        additional_fields: z
          .record(z.unknown())
          .optional()
          .describe('Additional CiviCRM contact fields as key-value pairs'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ contact_type, first_name, last_name, organization_name, email, phone, job_title, external_identifier, additional_fields }) => {
      try {
        const values: Record<string, unknown> = {
          contact_type,
          ...additional_fields,
        };
        if (first_name) values['first_name'] = first_name;
        if (last_name) values['last_name'] = last_name;
        if (organization_name) values['organization_name'] = organization_name;
        if (job_title) values['job_title'] = job_title;
        if (external_identifier) values['external_identifier'] = external_identifier;

        // Use API chaining to create email and phone atomically with the contact.
        // This avoids two-step failures and ensures location_type_id is always set.
        const chain: Record<string, unknown[]> = {};
        if (email) {
          chain['create_email'] = ['Email', 'create', {
            values: { contact_id: '$id', email, is_primary: true, location_type_id: 1 },
          }];
        }
        if (phone) {
          chain['create_phone'] = ['Phone', 'create', {
            values: { contact_id: '$id', phone, is_primary: true, location_type_id: 1 },
          }];
        }

        const createParams: Record<string, unknown> = { values };
        if (Object.keys(chain).length > 0) createParams['chain'] = chain;

        const result = await callCiviCRM('Contact', 'create', createParams);
        const createdId = (result.values?.[0] as Record<string, unknown> | undefined)?.['id'];

        if (!createdId) {
          return { content: [{ type: 'text', text: 'Contact creation failed — no ID returned.' }] };
        }

        // Fetch the full record so the response contains all saved fields.
        const fullResult = await callCiviCRM('Contact', 'get', {
          select: ['id', 'display_name', 'contact_type', 'first_name', 'last_name',
            'organization_name', 'job_title', 'email_primary.email',
            'phone_primary.phone', 'created_date'],
          where: [['id', '=', createdId]],
          limit: 1,
        });
        const contact = fullResult.values?.[0] ?? { id: createdId };

        return {
          content: [{ type: 'text', text: `Contact created successfully.\n\n${JSON.stringify(contact, null, 2)}` }],
          structuredContent: contact as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

  // ── Update Contact ────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_update_contact',
    {
      title: 'Update CiviCRM Contact',
      description: `Update an existing CiviCRM contact by ID.

Args:
  - id (number): The CiviCRM contact ID to update
  - fields (object): Fields to update as key-value pairs (e.g., {"first_name": "Jane", "job_title": "CEO"})

Only the fields provided in 'fields' will be updated; others remain unchanged.

Returns:
  The updated contact record.

Examples:
  - Change job title: id=42, fields={"job_title": "Director"}
  - Update organization name: id=10, fields={"organization_name": "New Corp Name"}`,
      inputSchema: z.object({
        id: zId.describe('CiviCRM contact ID to update'),
        fields: z.record(z.unknown()).describe('Fields to update as key-value pairs'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, fields }) => {
      try {
        await callCiviCRM('Contact', 'update', {
          values: fields,
          where: [['id', '=', id]],
        });

        // Fetch the updated record to confirm what was saved.
        const fullResult = await callCiviCRM('Contact', 'get', {
          select: ['id', 'display_name', 'contact_type', 'first_name', 'last_name',
            'organization_name', 'job_title', 'email_primary.email', 'phone_primary.phone'],
          where: [['id', '=', id]],
          limit: 1,
        });
        const contact = fullResult.values?.[0] ?? { id };

        return {
          content: [{ type: 'text', text: `Contact ${id} updated successfully.\n\n${JSON.stringify(contact, null, 2)}` }],
          structuredContent: contact as Record<string, unknown>,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

  // ── Delete Contact ────────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_delete_contact',
    {
      title: 'Delete CiviCRM Contact',
      description: `Delete a CiviCRM contact. By default performs a soft delete (moves to trash). Use permanent=true to permanently delete.

Args:
  - id (number): The CiviCRM contact ID to delete
  - permanent (boolean, default false): If true, permanently delete instead of soft-delete (trash)

WARNING: Permanent deletion cannot be undone. Soft-deleted contacts can be restored via the CiviCRM UI.

Returns:
  Confirmation message.`,
      inputSchema: z.object({
        id: zId.describe('CiviCRM contact ID to delete'),
        permanent: z
          .boolean()
          .default(false)
          .describe('Permanently delete (true) or move to trash (false, default)'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, permanent }) => {
      try {
        await callCiviCRM('Contact', 'delete', {
          where: [['id', '=', id]],
          useTrash: !permanent,
        });

        const msg = permanent
          ? `Contact ${id} permanently deleted.`
          : `Contact ${id} moved to trash (soft-deleted). It can be restored from the CiviCRM UI.`;
        return { content: [{ type: 'text', text: msg }] };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );
}
