# CiviCRM MCP Server

An MCP (Model Context Protocol) server for interacting with [CiviCRM](https://civicrm.org) via its APIv4 REST interface.

## Tools

### Contacts
- `civicrm_get_contacts` — Search/list contacts with filtering by name, email, type
- `civicrm_get_contact` — Get a single contact by ID with full details
- `civicrm_create_contact` — Create a new Individual, Organization, or Household
- `civicrm_update_contact` — Update contact fields by ID
- `civicrm_delete_contact` — Soft-delete or permanently delete a contact

### Activities
- `civicrm_get_activities` — Search activities with filters for contact, type, status, date
- `civicrm_create_activity` — Record a new activity (call, email, meeting, etc.)
- `civicrm_update_activity` — Update an existing activity

### Contributions
- `civicrm_get_contributions` — Search donations/payments with amount and date filters
- `civicrm_create_contribution` — Record a new contribution/payment
- `civicrm_update_contribution` — Update an existing contribution

### Events & Participants
- `civicrm_get_events` — Search/list events
- `civicrm_create_event` — Create a new event
- `civicrm_get_participants` — List participants for an event
- `civicrm_create_participant` — Register a contact for an event

### Memberships
- `civicrm_get_memberships` — Search membership records
- `civicrm_create_membership` — Create a new membership

### Groups
- `civicrm_get_groups` — Search/list contact groups
- `civicrm_get_group_contacts` — List members of a group
- `civicrm_manage_group_contact` — Add or remove a contact from a group

### Relationships
- `civicrm_get_relationships` — Search relationships between contacts
- `civicrm_create_relationship` — Create a relationship between two contacts

### Cases (requires CiviCase)
- `civicrm_get_cases` — Search case records
- `civicrm_create_case` — Create a new case

### Site Management
- `civicrm_use_site` — Select which CiviCRM site to query, or list available sites

### Generic / Discovery
- `civicrm_api` — Execute any APIv4 call directly (for entities/actions not covered above)
- `civicrm_get_entity_fields` — List all fields available for any entity
- `civicrm_get_entity_actions` — List all available actions for any entity

## Setup

### Environment Variables

#### Multi-site (recommended)

Configure any number of CiviCRM instances using slug-based env var pairs:

| Variable | Description |
|---|---|
| `CIVICRM_SITE_<SLUG>_URL` | Base URL for the site (e.g. `CIVICRM_SITE_WESSEX_URL`) |
| `CIVICRM_SITE_<SLUG>_KEY` | API key for the site (e.g. `CIVICRM_SITE_WESSEX_KEY`) |

The `<SLUG>` becomes the site identifier in lowercase with hyphens — `LMC_NORTH` → `lmc-north`.

#### Single-site (legacy fallback)

| Variable | Required | Description |
|---|---|---|
| `CIVICRM_BASE_URL` | Yes | Base URL of your CiviCRM site |
| `CIVICRM_API_KEY` | Yes | Your CiviCRM API key |

#### Other

| Variable | Default | Description |
|---|---|---|
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3000` | HTTP port (when using `http` transport) |

### Getting Your API Key

1. Log into CiviCRM as an admin
2. Navigate to a contact record → **Actions** → **API Key** (or via **Administer → CiviCRM API Keys**)
3. Generate and copy the API key
4. Ensure the AuthX extension is enabled: **Administer → System Settings → AuthX**

### Build

```bash
npm install
npm run build
```

### Run (stdio, single site)

```bash
export CIVICRM_BASE_URL="https://your-civicrm-site.org"
export CIVICRM_API_KEY="your-api-key"
node dist/index.js
```

### Run (stdio, multi-site)

```bash
export CIVICRM_SITE_WESSEX_URL="https://wessex.example.org"
export CIVICRM_SITE_WESSEX_KEY="key-for-wessex"
export CIVICRM_SITE_LMC_NORTH_URL="https://lmc-north.example.org"
export CIVICRM_SITE_LMC_NORTH_KEY="key-for-lmc-north"
node dist/index.js
# Then use: civicrm_use_site("wessex") or civicrm_use_site("lmc-north")
```

### Run (HTTP)

```bash
export CIVICRM_SITE_WESSEX_URL="https://wessex.example.org"
export CIVICRM_SITE_WESSEX_KEY="key-for-wessex"
export TRANSPORT=http
export PORT=3000
node dist/index.js
```

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

### Single site

```json
{
  "mcpServers": {
    "civicrm": {
      "command": "node",
      "args": ["/path/to/civicrm-MCP/dist/index.js"],
      "env": {
        "CIVICRM_BASE_URL": "https://your-civicrm-site.org",
        "CIVICRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Multiple sites

```json
{
  "mcpServers": {
    "civicrm": {
      "command": "node",
      "args": ["/path/to/civicrm-MCP/dist/index.js"],
      "env": {
        "CIVICRM_SITE_WESSEX_URL": "https://wessex.example.org",
        "CIVICRM_SITE_WESSEX_KEY": "key-for-wessex",
        "CIVICRM_SITE_LMC_NORTH_URL": "https://lmc-north.example.org",
        "CIVICRM_SITE_LMC_NORTH_KEY": "key-for-lmc-north"
      }
    }
  }
}
```

Then at the start of a conversation, tell the agent which site to use:

> "Use the wessex site"
> "Switch to lmc-north and find all contributions from last month"
> "What CiviCRM sites are available?"

## API Notes

- Uses **CiviCRM APIv4** exclusively (not the deprecated APIv3)
- All requests go to `{baseUrl}/civicrm/ajax/api4/{Entity}/{action}`
- Auth uses `X-Civi-Auth: Bearer {API_KEY}` header
- WordPress installs need the full verbose URL — set the site URL to `https://wordpress.example.org/wp-admin/admin.php?page=CiviCRM&q=`
