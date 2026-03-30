import axios, { AxiosError } from 'axios';
import { CHARACTER_LIMIT } from '../constants.js';
import { ApiCallParams, CiviCRMApiResponse } from '../types.js';

function getConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.CIVICRM_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.CIVICRM_API_KEY;

  if (!baseUrl) {
    throw new Error('CIVICRM_BASE_URL environment variable is required');
  }
  if (!apiKey) {
    throw new Error('CIVICRM_API_KEY environment variable is required');
  }

  return { baseUrl, apiKey };
}

/**
 * Make a CiviCRM APIv4 REST call.
 *
 * Endpoint: POST {baseUrl}/civicrm/ajax/api4/{Entity}/{action}
 * Body: params=<url-encoded-json>  (application/x-www-form-urlencoded)
 *
 * CiviCRM's ajax/api4 handler reads $_REQUEST['params'] first, then falls back
 * to php://input. Sending a named form field `params=` is the most compatible
 * format across all CMS backends (WordPress, Drupal, Joomla).
 *
 * Auth: X-Civi-Auth: Bearer {apiKey}
 */
export async function callCiviCRM<T = Record<string, unknown>>(
  entity: string,
  action: string,
  params: ApiCallParams = {}
): Promise<CiviCRMApiResponse<T>> {
  const { baseUrl, apiKey } = getConfig();
  const url = `${baseUrl}/civicrm/ajax/api4/${entity}/${action}`;
  const body = `params=${encodeURIComponent(JSON.stringify(params))}`;

  try {
    const response = await axios.post<CiviCRMApiResponse<T>>(url, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Civi-Auth': `Bearer ${apiKey}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 30_000,
    });

    const data = response.data;

    if (data.error_message) {
      throw new Error(`CiviCRM API Error (${data.error_code ?? 'unknown'}): ${data.error_message}`);
    }

    return data;
  } catch (error) {
    if (error instanceof AxiosError) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error(
          'Authentication failed. Verify CIVICRM_API_KEY is correct and the user has sufficient CiviCRM permissions.'
        );
      }
      if (error.response?.status === 404) {
        throw new Error(
          `Endpoint not found for ${entity}.${action}. Check the entity/action names and that the CiviCRM instance is reachable.`
        );
      }
      if (error.code === 'ECONNABORTED') {
        throw new Error('Request timed out. The CiviCRM server may be slow or unresponsive.');
      }
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error(
          `Cannot connect to CiviCRM at ${process.env.CIVICRM_BASE_URL}. Check CIVICRM_BASE_URL is correct and the server is running.`
        );
      }
      // Try to extract error message from response body
      const responseData = error.response?.data as CiviCRMApiResponse | undefined;
      if (responseData?.error_message) {
        throw new Error(`CiviCRM Error: ${responseData.error_message}`);
      }
      throw new Error(`HTTP ${error.response?.status ?? 'unknown'}: ${error.message}`);
    }
    // Re-throw CiviCRM API errors (from above) and other errors
    throw error;
  }
}

/** Format a tool error into a user-friendly string. */
export function handleToolError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

/** Truncate a response string if it exceeds the character limit. */
export function truncateIfNeeded(text: string, hint?: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const msg = hint
    ? `\n\n[Response truncated. ${hint}]`
    : '\n\n[Response truncated. Use limit/offset parameters to paginate or narrow your search.]';
  return text.slice(0, CHARACTER_LIMIT) + msg;
}

/** Build pagination metadata for list responses. */
export function buildPagination(
  total: number | undefined,
  count: number,
  offset: number,
  limit: number
): {
  total: number | null;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
} {
  const hasMore = total !== undefined ? offset + count < total : count >= limit;
  return {
    total: total ?? null,
    count,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + count } : {}),
  };
}
