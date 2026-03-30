import axios, { AxiosError } from 'axios';
import { CHARACTER_LIMIT } from '../constants.js';
import { ApiCallParams, CiviCRMApiResponse } from '../types.js';

// ── Site registry ────────────────────────────────────────────────────────────

interface SiteConfig {
  url: string;
  key: string;
}

/** All sites discovered at startup from env vars. */
const siteRegistry = new Map<string, SiteConfig>();

/** Currently active site for this process session. */
let activeSite: (SiteConfig & { slug: string }) | null = null;

/**
 * Convert a user-provided slug to the env var prefix.
 * "lmc-north" → "LMC_NORTH"
 */
function slugToEnvPrefix(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_');
}

/**
 * Scan process.env at startup for all CIVICRM_SITE_<SLUG>_URL entries.
 * Pairs each with its corresponding CIVICRM_SITE_<SLUG>_KEY.
 * Falls back to legacy CIVICRM_BASE_URL / CIVICRM_API_KEY if no sites found.
 */
export function loadSiteRegistry(): void {
  const urlPattern = /^CIVICRM_SITE_(.+)_URL$/;

  for (const [key, value] of Object.entries(process.env)) {
    const match = urlPattern.exec(key);
    if (!match || !value) continue;

    const prefix = match[1]; // e.g. "WESSEX" or "LMC_NORTH"
    const apiKey = process.env[`CIVICRM_SITE_${prefix}_KEY`];

    if (!apiKey) {
      console.error(`WARN: CIVICRM_SITE_${prefix}_URL is set but CIVICRM_SITE_${prefix}_KEY is missing — skipping`);
      continue;
    }

    // Store under lowercase hyphenated slug for user-facing display
    const slug = prefix.toLowerCase().replace(/_/g, '-');
    siteRegistry.set(slug, { url: value.replace(/\/$/, ''), key: apiKey });
  }

  // Legacy single-site fallback
  if (siteRegistry.size === 0) {
    const url = process.env.CIVICRM_BASE_URL;
    const key = process.env.CIVICRM_API_KEY;
    if (url && key) {
      siteRegistry.set('default', { url: url.replace(/\/$/, ''), key });
      activeSite = { slug: 'default', url: url.replace(/\/$/, ''), key };
      console.error('INFO: Using legacy CIVICRM_BASE_URL / CIVICRM_API_KEY as "default" site');
    }
  }

  if (siteRegistry.size === 0) {
    console.error('ERROR: No CiviCRM sites configured. Add CIVICRM_SITE_<SLUG>_URL and CIVICRM_SITE_<SLUG>_KEY env vars.');
    process.exit(1);
  }

  console.error(`INFO: ${siteRegistry.size} site(s) loaded: ${[...siteRegistry.keys()].join(', ')}`);
}

/** Return sorted list of available site slugs. */
export function getAvailableSites(): string[] {
  return [...siteRegistry.keys()].sort();
}

/**
 * Set the active site by slug. Returns the site config on success,
 * or throws with a helpful message listing valid slugs.
 */
export function selectSite(slug: string): SiteConfig & { slug: string } {
  const normalised = slug.toLowerCase().trim();
  const site = siteRegistry.get(normalised);

  if (!site) {
    const available = getAvailableSites().join(', ');
    throw new Error(`Unknown site "${slug}". Available sites: ${available}`);
  }

  activeSite = { slug: normalised, ...site };
  return activeSite;
}

/** Return the currently active site or throw asking user to select one. */
function getConfig(): { baseUrl: string; apiKey: string } {
  if (!activeSite) {
    const available = getAvailableSites().join(', ');
    throw new Error(
      `No site selected. Call civicrm_use_site first.\nAvailable sites: ${available}`
    );
  }
  return { baseUrl: activeSite.url, apiKey: activeSite.key };
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
