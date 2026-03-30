import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCiviCRM, handleToolError, truncateIfNeeded } from '../services/civicrm.js';
import { ResponseFormat } from '../types.js';
import { DEFAULT_LIMIT } from '../constants.js';

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.JSON)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

export function registerGenericTools(server: McpServer): void {
  // ── Generic API Call ──────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_api',
    {
      title: 'Generic CiviCRM APIv4 Call',
      description: `Execute any CiviCRM APIv4 call directly. Use this for entities and actions not covered by the specialized tools, or for advanced queries.

Args:
  - entity (string): CiviCRM entity name (e.g., "Contact", "Activity", "Tag", "CustomField", "OptionValue")
  - action (string): API action (e.g., "get", "create", "update", "delete", "save", "getFields", "getActions")
  - params (object, optional): API parameters object, following CiviCRM APIv4 conventions:
    - select: array of field names to return
    - where: array of [field, operator, value] conditions (e.g., [["id", "=", 42]])
    - orderBy: object of {field: "ASC"|"DESC"}
    - limit: max records to return
    - offset: pagination offset
    - values: for create/update, the field values to set
    - join: for related entity joins

Returns:
  Raw API response with count and values array.

Examples:
  - List all option groups: entity="OptionGroup", action="get"
  - Get activity types: entity="OptionValue", action="get", params={"where": [["option_group_id:name", "=", "activity_type"]]}
  - Get custom fields for Contact: entity="CustomField", action="get", params={"where": [["custom_group_id.extends", "=", "Contact"]]}
  - Find duplicate contacts: entity="Contact", action="get", params={"where": [["is_deleted", "=", false]], "limit": 5}`,
      inputSchema: z.object({
        entity: z.string().min(1).describe('CiviCRM entity name (e.g., "Contact", "Activity", "Tag")'),
        action: z
          .string()
          .min(1)
          .describe('API action (e.g., "get", "create", "update", "delete", "getFields", "getActions")'),
        params: z
          .union([
            z.record(z.unknown()),
            z.string().transform((s, ctx) => {
              try {
                const parsed = JSON.parse(s);
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                  return parsed as Record<string, unknown>;
                }
                ctx.addIssue({ code: 'custom', message: 'params string must be a JSON object' });
                return z.NEVER;
              } catch {
                ctx.addIssue({ code: 'custom', message: `params is not valid JSON: ${s}` });
                return z.NEVER;
              }
            }),
          ])
          .optional()
          .describe('APIv4 parameters as an object or JSON string (select, where, orderBy, limit, offset, values, etc.)'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ entity, action, params, response_format }) => {
      try {
        // Apply a sensible default limit for 'get' actions if not specified
        const apiParams = params ?? {};
        if (action === 'get' && !apiParams['limit']) {
          apiParams['limit'] = DEFAULT_LIMIT;
        }

        const result = await callCiviCRM(entity, action, apiParams);

        const output = {
          entity,
          action,
          count: result.count ?? (result.values?.length ?? 0),
          countMatched: result.countMatched,
          values: result.values ?? [],
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [
            `# CiviCRM ${entity}.${action} Results`,
            '',
            `**Count**: ${output.count}${output.countMatched !== undefined ? ` (of ${output.countMatched} total)` : ''}`,
            '',
            '```json',
            JSON.stringify(output.values, null, 2),
            '```',
          ];
          text = lines.join('\n');
        } else {
          text = JSON.stringify(output, null, 2);
        }

        return {
          content: [{ type: 'text', text: truncateIfNeeded(text, 'Refine your query using select, where, or limit parameters to reduce results.') }],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );

  // ── Get Entity Fields ─────────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_entity_fields',
    {
      title: 'Get CiviCRM Entity Fields',
      description: `Retrieve the list of fields (including custom fields) available for a CiviCRM entity. Use this to discover what fields you can use in queries and create/update operations.

Args:
  - entity (string): CiviCRM entity name (e.g., "Contact", "Activity", "Contribution", "Event")
  - include_options (boolean, default false): Include option values for select fields (slower)
  - response_format ('markdown'|'json'): Output format

Returns:
  List of fields with names, types, labels, and descriptions.

Examples:
  - See all Contact fields: entity="Contact"
  - See Activity fields with options: entity="Activity", include_options=true
  - Discover custom fields on Contribution: entity="Contribution"`,
      inputSchema: z.object({
        entity: z.string().min(1).describe('CiviCRM entity name (e.g., "Contact", "Activity")'),
        include_options: z
          .boolean()
          .default(false)
          .describe('Include option values for select fields (slower)'),
        response_format: ResponseFormatSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ entity, include_options, response_format }) => {
      try {
        const result = await callCiviCRM(entity, 'getFields', {
          select: ['name', 'title', 'data_type', 'input_type', 'required', 'description',
            'default_value', 'read_only', 'nullable', 'operators',
            ...(include_options ? ['options'] : [])],
          where: [['deprecated', '=', false]],
          orderBy: { name: 'ASC' },
        });

        const fields = result.values ?? [];

        if (fields.length === 0) {
          return { content: [{ type: 'text', text: `No fields found for entity "${entity}".` }] };
        }

        const output = { entity, field_count: fields.length, fields };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# ${entity} Fields (${fields.length} total)`, ''];
          for (const f of fields as Record<string, unknown>[]) {
            const required = f['required'] ? ' *(required)*' : '';
            const readOnly = f['read_only'] ? ' *(read-only)*' : '';
            lines.push(`### \`${f['name']}\` — ${f['title']}${required}${readOnly}`);
            lines.push(`- **Type**: ${f['data_type']} (${f['input_type']})`);
            if (f['description']) lines.push(`- **Description**: ${f['description']}`);
            if (f['default_value'] !== undefined && f['default_value'] !== null) {
              lines.push(`- **Default**: ${JSON.stringify(f['default_value'])}`);
            }
            if (f['options'] && typeof f['options'] === 'object') {
              const opts = Object.entries(f['options'] as Record<string, string>)
                .slice(0, 10)
                .map(([k, v]) => `${k}="${v}"`)
                .join(', ');
              lines.push(`- **Options**: ${opts}${Object.keys(f['options'] as object).length > 10 ? '...' : ''}`);
            }
            lines.push('');
          }
          text = lines.join('\n');
        } else {
          text = JSON.stringify(output, null, 2);
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

  // ── Get Available Actions ─────────────────────────────────────────────────
  server.registerTool(
    'civicrm_get_entity_actions',
    {
      title: 'Get Available Actions for a CiviCRM Entity',
      description: `List all available API actions for a CiviCRM entity. Use this to discover what operations are supported.

Args:
  - entity (string): CiviCRM entity name (e.g., "Contact", "Activity", "Contribution")

Returns:
  List of available actions with names and descriptions.`,
      inputSchema: z.object({
        entity: z.string().min(1).describe('CiviCRM entity name'),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ entity }) => {
      try {
        const result = await callCiviCRM(entity, 'getActions', {});

        const actions = result.values ?? [];
        const output = { entity, actions };

        const lines = [`# Available Actions for ${entity}`, ''];
        for (const a of actions as Record<string, unknown>[]) {
          lines.push(`- **${a['name']}**: ${a['description'] ?? 'No description'}`);
        }
        const text = lines.join('\n');

        return {
          content: [{ type: 'text', text: text }],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: handleToolError(error) }] };
      }
    }
  );
}
