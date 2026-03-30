export enum ResponseFormat {
  MARKDOWN = 'markdown',
  JSON = 'json',
}

export interface CiviCRMApiResponse<T = Record<string, unknown>> {
  version?: number;
  count?: number;
  countMatched?: number;
  values?: T[];
  error_code?: number | string;
  error_message?: string;
}

export type WhereClause = unknown[];

export interface ApiCallParams {
  select?: string[];
  where?: WhereClause[];
  having?: WhereClause[];
  join?: unknown[];
  orderBy?: Record<string, 'ASC' | 'DESC'>;
  limit?: number;
  offset?: number;
  values?: Record<string, unknown>;
  match?: string[];
  chain?: Record<string, unknown[]>;
  [key: string]: unknown;
}

// Common CiviCRM entity shapes
export interface CiviContact {
  id?: number;
  contact_type?: string;
  contact_sub_type?: string[];
  display_name?: string;
  first_name?: string;
  last_name?: string;
  organization_name?: string;
  email_primary?: { email?: string };
  phone_primary?: { phone?: string };
  address_primary?: { street_address?: string; city?: string; state_province_id?: string; postal_code?: string; country_id?: string };
  [key: string]: unknown;
}

export interface CiviActivity {
  id?: number;
  activity_type_id?: number | string;
  subject?: string;
  activity_date_time?: string;
  status_id?: number | string;
  details?: string;
  source_contact_id?: number;
  [key: string]: unknown;
}

export interface CiviContribution {
  id?: number;
  contact_id?: number;
  financial_type_id?: number | string;
  total_amount?: number;
  currency?: string;
  receive_date?: string;
  contribution_status_id?: number | string;
  [key: string]: unknown;
}

export interface CiviEvent {
  id?: number;
  title?: string;
  event_type_id?: number | string;
  start_date?: string;
  end_date?: string;
  is_active?: boolean;
  [key: string]: unknown;
}

export interface CiviGroup {
  id?: number;
  name?: string;
  title?: string;
  description?: string;
  group_type?: string[];
  [key: string]: unknown;
}
