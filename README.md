# Supabase MCP Server (Self-Hosted)

> MCP Server for Self-Hosted Supabase - Optimized for single-instance management

[![npm version](https://img.shields.io/npm/v/@jun-b/supabase-mcp-sf@latest)](https://www.npmjs.com/package/@jun-b/supabase-mcp-sf@latest)
[![License](https://img.shields.io/npm/l/@jun-b/supabase-mcp-sf@latest)](https://github.com/Song-JunHyeong/supabase-sf/blob/master/LICENSE)

Connect AI assistants (Claude, Cursor, etc.) directly to your self-hosted Supabase instance via the [Model Context Protocol](https://modelcontextprotocol.io/introduction).

## Key Features

- **Self-Hosted First** - Designed specifically for self-hosted Supabase instances
- **SRE/Operations Tools** - Health checks, backups, secret rotation (unlike official MCP)
- **Granular Security** - Fine-grained read-only/read-write control
- **Server Panel/PaaS Ready** - Script integration for automated maintenance

## Comparison: Official vs Self-Hosted MCP

| Feature                    | Official Supabase MCP |    Supabase MCP (Self-Hosted)    |
| -------------------------- | :-------------------: | :------------------------------: |
| Target Environment         |  Supabase Cloud Only  |     Self-Hosted (Docker/VPS)     |
| Authentication             | OAuth (Cloud Account) | Direct Key (Service Role / Anon) |
| Multi-Project Management   |          ✅          |  ⚠️ (Single Instance Focus)  |
| SRE Tools (Backup, Rotate) |          ❌          |      ✅ (via Shell Scripts)      |
| Health Checks              |          ❌          |        ✅ (Service-level)        |
| Storage Management         |          ✅          |   ✅ (Supports Local Storage)   |
| Cost Management            |          ✅          |        N/A (Self-Hosted)        |
| Branching                  |       ✅ (Paid)       |        ✅ (Schema-based)        |
| Edge Functions Deploy      |      ✅ (Cloud)      |        ✅ (Manual + API)        |
| Custom AI Agent Role       |          ❌          |       ✅ (RLS Integration)       |

## Installation

```bash
npx @jun-b/supabase-mcp-sf@latest
```

That's it! No global installation required.

### Docker (Optional)

For server deployment (EasyPanel, Coolify, etc.):

```bash
# Build
docker build -t supabase-mcp-sf .

# Run
docker run -e SUPABASE_URL=http://host.docker.internal:8000 \
           -e SUPABASE_SERVICE_ROLE_KEY=your-key \
           supabase-mcp-sf
```

Or use Docker Compose:

```bash
docker compose -f docker-compose.mcp.yml up -d
```

## Configuration

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "supabase-sf": {
      "command": "npx",
      "args": ["-y", "@jun-b/supabase-mcp-sf@latest"],
      "env": {
        "SUPABASE_URL": "http://localhost",
        "SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key",
        "SUPABASE_ANON_KEY": "your-anon-key"
      }
    }
  }
}
```

### Environment Variables

| Variable                      | Required | Description              |
| ----------------------------- | -------- | ------------------------ |
| `SUPABASE_URL`              | ✅       | Self-hosted Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅       | Service role key         |
| `SUPABASE_ANON_KEY`         | ❌       | Anonymous key (optional) |

## Supported Tools

### Database

- `execute_sql`: Execute SQL queries
- `list_tables`: List tables in schemas
- `list_extensions`: List database extensions
- `list_migrations`: List applied migrations
- `apply_migration`: Apply schema migrations

### Docs (Knowledge Base)

- `search_docs`: Search Supabase official documentation

### Debugging

- `get_logs`: Get service logs (api, postgres, auth, storage, realtime, functions)
- `get_advisors`: Get security/performance recommendations

### Development

- `get_project_url`: Get project URL
- `get_anon_key`: Get anonymous API key
- `get_publishable_keys`: Get all API keys
- `generate_typescript_types`: Generate TypeScript types from schema

### Edge Functions

- `list_edge_functions`: List deployed functions
- `get_edge_function`: Get function details
- `invoke_edge_function`: Invoke a function
- `deploy_edge_function`: Deploy/update a function

### Branching (Experimental)

- `list_branches`: List database branches
- `create_branch`: Create a new branch
- `delete_branch`: Delete a branch
- `merge_branch`: Merge changes between branches
- `reset_branch`: Reset to migration version
- `rebase_branch`: Rebase onto another branch

### Storage (File Management)

- `list_storage_buckets`: List storage buckets
- `list_files`: List files in a bucket
- `upload_file`: Upload a file (base64)
- `download_file`: Get signed download URL
- `delete_file`: Delete files
- `create_signed_url`: Create temporary access URL
- `get_storage_config`: Get storage configuration
- `update_storage_config`: Update storage configuration

### Auth (User Management)

- `list_users`: List all users
- `get_user`: Get user by ID
- `create_user`: Create a new user
- `delete_user`: Delete a user
- `generate_link`: Generate magic/recovery/invite links

### Operations (SRE) 🆕

- `check_health`: Comprehensive health check of all services
- `backup_now`: Create immediate database backup
- `rotate_secret`: Rotate secrets (JWT, postgres password, vault key)
- `get_stats`: Get system statistics (DB size, connections, users)
- `run_script`: Execute maintenance scripts

#### AI as Your SRE: Auto-Healing Scenario

With Operations tools, your AI assistant can act as an autonomous SRE:

```
1. AI detects an issue via `check_health`
   → "Auth service is unhealthy"

2. AI reads logs via `get_logs`
   → "JWT validation errors detected"

3. AI decides to rotate secrets via `rotate_secret`
   → "Rotating JWT secret (dry-run first)..."

4. AI triggers `backup_now` before applying critical fixes
   → "Backup created: backup_20241207_120000.sql"

5. AI provides remediation instructions
   → "Run: docker compose restart auth"
```

This enables **AI-powered incident response** for your self-hosted Supabase!

## CLI Options

```bash
supabase-mcp-sf [options]

Options:
  --supabase-url <url>        Supabase URL
  --service-role-key <key>    Service role key
  --anon-key <key>            Anon key (optional)
  --read-only                 Read-only mode (disable writes)
  --features <list>           Enable specific features
  --version                   Show version
```

## Feature Control

Enable specific features via `--features`:

```bash
# Enable only database and operations
supabase-mcp-sf --features database,operations

# All features
supabase-mcp-sf --features database,debugging,development,storage,auth,functions,branching,docs,operations
```

## Security

### Read-Only Mode

```bash
supabase-mcp-sf --read-only
```

Disables all write operations (migrations, file uploads, user creation, etc.)

### Custom AI Agent Role

For production, create a dedicated database role for AI agents:

```sql
-- Create AI agent role with limited permissions
CREATE ROLE ai_agent WITH LOGIN PASSWORD 'secure-password';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_agent;
GRANT EXECUTE ON FUNCTION specific_functions TO ai_agent;
```

> **💡 Tip**: Combine with PostgREST's Row Level Security (RLS) for maximum control. Create policies specifically for the `ai_agent` role to strictly limit what data the AI can see or modify.

```sql
-- Example: AI can only see non-sensitive user data
CREATE POLICY ai_agent_users ON auth.users
  FOR SELECT TO ai_agent
  USING (raw_user_meta_data->>'is_public' = 'true');
```

> ⚠️ **Warning**: The `SERVICE_ROLE_KEY` bypasses RLS. Only use in trusted environments.

## Integration with Server Panel / PaaS

The operations tools can trigger server-side scripts for automated maintenance:

```bash
# AI can request backup
./scripts/backup.sh

# AI can rotate secrets
./scripts/rotate-jwt-secret.sh

# AI can check health
./scripts/check-health.sh
```

### Example AI Prompts

**Health Check & Backup:**

```
"Check the health of my Supabase instance. If everything is healthy, 
create a database backup and then list all users created in the last 24 hours."
```

**Incident Response:**

```
"The auth service seems slow. Check the logs for any errors in the last hour, 
and tell me if I need to restart any services."
```

**Statistics Report:**

```
"Give me a summary of my Supabase instance: database size, active connections, 
total users, and storage usage."
```

## Related Projects

- **[supabase-sf](https://github.com/Song-JunHyeong/supabase-sf)** - Production-ready Docker Compose setup for self-hosting Supabase with automated secret management. This MCP server is designed to work seamlessly with supabase-sf.

## License

Apache 2.0
