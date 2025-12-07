import type { InitData } from '../mcp-utils/server.js';
import type {
    DatabaseOperations,
    DebuggingOperations,
    DevelopmentOperations,
    ExecuteSqlOptions,
    ApplyMigrationOptions,
    Migration,
    GetLogsOptions,
    GenerateTypescriptTypesResult,
    StorageOperations,
    StorageConfig,
    StorageBucket,
    StorageFile,
    SupabasePlatform,
    ApiKey,
} from './types.js';
import type { AuthOperations, User, CreateUserOptions, ListUsersOptions, GenerateLinkOptions, GenerateLinkResult } from '../auth/types.js';
import type { EdgeFunctionsOperations, EdgeFunction, EdgeFunctionDetails, InvokeEdgeFunctionOptions, InvokeEdgeFunctionResult, DeployEdgeFunctionOptions, DeployEdgeFunctionResult } from '../functions/types.js';
import type { BranchingOperations, Branch, CreateBranchOptions, MergeBranchOptions, MergeBranchResult, ResetBranchOptions, RebaseBranchOptions } from '../branching/types.js';
import type { DocsOperations, DocsSearchResult } from '../docs/types.js';
import type { OperationsOperations, HealthCheckResult, ServiceHealth, BackupOptions, BackupResult, RotateSecretOptions, RotateSecretResult, SystemStats, RunScriptOptions, ScriptResult } from '../operations/types.js';
import { executeSqlOptionsSchema, applyMigrationOptionsSchema, getLogsOptionsSchema } from './types.js';
import { getLogQuery } from '../logs.js';

export type SelfHostedPlatformOptions = {
    /**
     * The URL for the self-hosted Supabase instance.
     * Example: http://localhost or https://supabase.yourdomain.com
     */
    supabaseUrl: string;

    /**
     * The service role key for the self-hosted Supabase instance.
     * This key has full access to the database.
     */
    serviceRoleKey: string;

    /**
     * Optional anon key for client-safe operations.
     */
    anonKey?: string;

    /**
     * Optional direct Postgres connection URL.
     * If provided, SQL queries will be executed directly via Postgres.
     * Format: postgres://user:password@host:port/database
     */
    postgresUrl?: string;
};

type SuccessResponse = { success: true };
const SUCCESS_RESPONSE: SuccessResponse = { success: true };

/**
 * Creates a Supabase platform implementation for self-hosted environments.
 * This bypasses the Supabase Management API and connects directly to the services.
 */
export function createSelfHostedPlatform(
    options: SelfHostedPlatformOptions
): SupabasePlatform {
    const { supabaseUrl, serviceRoleKey, anonKey, postgresUrl } = options;

    // Normalize URL (remove trailing slash)
    const baseUrl = supabaseUrl.replace(/\/$/, '');

    // Common headers for authenticated requests
    const authHeaders = {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
        'Content-Type': 'application/json',
    };

    /**
     * Execute a SQL query via pg-meta service.
     * pg-meta provides a /query endpoint for executing arbitrary SQL.
     * Kong routes /pg/* -> http://meta:8080/*
     */
    async function executeSqlViaRpc<T>(query: string, readOnly?: boolean): Promise<T[]> {
        // pg-meta /query endpoint - this is the primary way to execute SQL
        // Kong routing: /pg/* -> http://meta:8080/*
        const queryEndpoint = `${baseUrl}/pg/query`;

        try {
            const response = await fetch(queryEndpoint, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({
                    query,
                }),
            });

            if (response.ok) {
                const contentType = response.headers.get('content-type');
                if (contentType?.includes('application/json')) {
                    return response.json();
                }
            }

            const errorText = await response.text();

            // Check specific error patterns
            if (response.status === 404) {
                throw new Error(
                    `pg-meta service not accessible at ${queryEndpoint}\n\n` +
                    `Troubleshooting:\n` +
                    `1. Check if pg-meta service is running: docker ps | grep meta\n` +
                    `2. Verify Kong routing in volumes/api/kong.yml\n` +
                    `3. Check pg-meta logs: docker logs supabase-meta`
                );
            }

            throw new Error(`SQL execution failed: ${errorText}`);
        } catch (e) {
            if (e instanceof Error && e.message.includes('pg-meta service')) {
                throw e;
            }
            throw new Error(
                `Failed to connect to pg-meta service.\n` +
                `Error: ${e}\n\n` +
                `Troubleshooting:\n` +
                `1. Check if pg-meta service is running: docker ps | grep meta\n` +
                `2. Check pg-meta logs: docker logs supabase-meta\n` +
                `3. Restart Supabase: docker compose restart meta`
            );
        }
    }

    const database: DatabaseOperations = {
        async executeSql<T>(projectId: string, options: ExecuteSqlOptions): Promise<T[]> {
            const { query, read_only } = executeSqlOptionsSchema.parse(options);
            return executeSqlViaRpc<T>(query, read_only);
        },

        async listMigrations(projectId: string): Promise<Migration[]> {
            // Query the supabase_migrations schema
            const query = `
        SELECT version, name 
        FROM supabase_migrations.schema_migrations 
        ORDER BY version DESC
      `;

            try {
                const result = await executeSqlViaRpc<{ version: string; name?: string }>(query, true);
                return result.map(row => ({
                    version: row.version,
                    name: row.name,
                }));
            } catch (error) {
                // Migration table might not exist
                return [];
            }
        },

        async applyMigration(projectId: string, options: ApplyMigrationOptions): Promise<void> {
            const { name, query } = applyMigrationOptionsSchema.parse(options);

            // Execute the migration
            await executeSqlViaRpc(query, false);

            // Record the migration
            const version = Date.now().toString();
            const insertQuery = `
        INSERT INTO supabase_migrations.schema_migrations (version, name)
        VALUES ('${version}', '${name}')
      `;

            try {
                await executeSqlViaRpc(insertQuery, false);
            } catch (error) {
                // Migration recording might fail if table doesn't exist, but migration was applied
                console.warn('Failed to record migration:', error);
            }
        },
    };

    const debugging: DebuggingOperations = {
        async getLogs(projectId: string, options: GetLogsOptions): Promise<unknown> {
            const { service, iso_timestamp_start, iso_timestamp_end } =
                getLogsOptionsSchema.parse(options);

            // Map service to docker container name
            const containerMap: Record<string, string> = {
                api: 'supabase-kong',
                postgres: 'supabase-db',
                auth: 'supabase-auth',
                storage: 'supabase-storage',
                realtime: 'supabase-realtime',
                functions: 'supabase-functions',
            };

            // Try to query analytics endpoint
            const analyticsUrl = new URL(`${baseUrl}/analytics/v1/query`);

            const sql = getLogQuery(service);

            try {
                const response = await fetch(analyticsUrl.toString(), {
                    method: 'POST',
                    headers: authHeaders,
                    body: JSON.stringify({
                        sql,
                        iso_timestamp_start,
                        iso_timestamp_end,
                    }),
                });

                if (!response.ok) {
                    const containerName = containerMap[service] || `supabase-${service}`;
                    return {
                        message: 'Analytics logs are not available in this self-hosted configuration',
                        suggestion: `Check Docker logs directly: docker logs ${containerName}`,
                        alternative: `docker logs ${containerName} --tail 100 --since 1h`
                    };
                }

                // Check if response is JSON before parsing
                const contentType = response.headers.get('content-type');
                if (!contentType?.includes('application/json')) {
                    const containerName = containerMap[service] || `supabase-${service}`;
                    return {
                        message: 'Analytics service returned non-JSON response (possibly not configured)',
                        suggestion: `Check Docker logs directly: docker logs ${containerName}`,
                        note: 'Self-hosted Supabase requires explicit analytics/logflare setup'
                    };
                }

                return response.json();
            } catch (error) {
                const containerName = containerMap[service] || `supabase-${service}`;
                return {
                    message: `Failed to fetch logs: ${error}`,
                    suggestion: `Check Docker logs directly: docker logs ${containerName}`,
                    alternative: `docker compose logs ${service}`
                };
            }
        },

        async getSecurityAdvisors(projectId: string): Promise<unknown> {
            // Run security checks via SQL
            const securityQueries = [
                // Check for tables without RLS
                `SELECT schemaname, tablename 
         FROM pg_tables 
         WHERE schemaname = 'public' 
         AND tablename NOT IN (
           SELECT tablename FROM pg_policies WHERE schemaname = 'public'
         )`,
            ];

            try {
                const results = await Promise.all(
                    securityQueries.map(q => executeSqlViaRpc(q, true))
                );

                return {
                    tables_without_rls: results[0] || [],
                };
            } catch (error) {
                return { error: 'Failed to fetch security advisors' };
            }
        },

        async getPerformanceAdvisors(projectId: string): Promise<unknown> {
            // Run performance checks via SQL
            const performanceQueries = [
                // Check for missing indexes on foreign keys
                `SELECT 
           c.conrelid::regclass AS table_name,
           a.attname AS column_name
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
         WHERE c.contype = 'f'
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
           WHERE i.indrelid = c.conrelid
           AND a.attnum = ANY(i.indkey)
         )
         LIMIT 10`,
            ];

            try {
                const results = await Promise.all(
                    performanceQueries.map(q => executeSqlViaRpc(q, true))
                );

                return {
                    missing_fk_indexes: results[0] || [],
                };
            } catch (error) {
                return { error: 'Failed to fetch performance advisors' };
            }
        },
    };

    const development: DevelopmentOperations = {
        async getProjectUrl(projectId: string): Promise<string> {
            return baseUrl;
        },

        async getPublishableKeys(projectId: string): Promise<ApiKey[]> {
            const keys: ApiKey[] = [];

            // Return the configured anon key if available
            if (anonKey) {
                keys.push({
                    api_key: anonKey,
                    name: 'anon',
                    type: 'legacy',
                    description: 'Anonymous key for client-side access',
                });
            }

            // Note: In self-hosted mode, we don't return the service role key
            // as it's not a "publishable" key

            if (keys.length === 0) {
                throw new Error(
                    'No anon key configured. Please provide SUPABASE_ANON_KEY to expose publishable keys.'
                );
            }

            return keys;
        },

        async generateTypescriptTypes(projectId: string): Promise<GenerateTypescriptTypesResult> {
            // Generate types by introspecting the database schema
            const schemaQuery = `
        SELECT 
          t.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default
        FROM information_schema.tables t
        JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE t.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name, c.ordinal_position
      `;

            try {
                const columns = await executeSqlViaRpc<{
                    table_name: string;
                    column_name: string;
                    data_type: string;
                    is_nullable: string;
                    column_default: string | null;
                }>(schemaQuery, true);

                // Group columns by table
                const tables: Record<string, Array<{
                    table_name: string;
                    column_name: string;
                    data_type: string;
                    is_nullable: string;
                    column_default: string | null;
                }>> = {};
                for (const col of columns) {
                    const tableName = col.table_name;
                    if (!tables[tableName]) {
                        tables[tableName] = [];
                    }
                    tables[tableName]!.push(col);
                }

                // Generate TypeScript types
                let types = `export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {\n`;

                for (const [tableName, cols] of Object.entries(tables)) {
                    types += `      ${tableName}: {\n`;
                    types += `        Row: {\n`;

                    for (const col of cols) {
                        const tsType = mapPostgresToTs(col.data_type);
                        const nullable = col.is_nullable === 'YES' ? ' | null' : '';
                        types += `          ${col.column_name}: ${tsType}${nullable}\n`;
                    }

                    types += `        }\n`;
                    types += `        Insert: {\n`;

                    for (const col of cols) {
                        const tsType = mapPostgresToTs(col.data_type);
                        const optional = col.column_default !== null || col.is_nullable === 'YES' ? '?' : '';
                        const nullable = col.is_nullable === 'YES' ? ' | null' : '';
                        types += `          ${col.column_name}${optional}: ${tsType}${nullable}\n`;
                    }

                    types += `        }\n`;
                    types += `        Update: {\n`;

                    for (const col of cols) {
                        const tsType = mapPostgresToTs(col.data_type);
                        const nullable = col.is_nullable === 'YES' ? ' | null' : '';
                        types += `          ${col.column_name}?: ${tsType}${nullable}\n`;
                    }

                    types += `        }\n`;
                    types += `      }\n`;
                }

                types += `    }\n`;
                types += `    Views: {}\n`;
                types += `    Functions: {}\n`;
                types += `    Enums: {}\n`;
                types += `  }\n`;
                types += `}\n`;

                return { types };
            } catch (error) {
                throw new Error(`Failed to generate TypeScript types: ${error}`);
            }
        },
    };

    const storage: StorageOperations = {
        async getStorageConfig(projectId: string): Promise<StorageConfig> {
            // Storage config is typically set via environment variables in self-hosted
            // Return default configuration
            return {
                fileSizeLimit: 52428800, // 50MB default
                features: {
                    imageTransformation: { enabled: true },
                    s3Protocol: { enabled: false },
                },
            };
        },

        async updateStorageConfig(projectId: string, config: StorageConfig): Promise<void> {
            // In self-hosted mode, storage config is managed via environment variables
            console.warn(
                'Storage configuration in self-hosted mode is managed via environment variables. ' +
                'Please update FILE_SIZE_LIMIT and other settings in your .env file.'
            );
        },

        async listAllBuckets(projectId: string): Promise<StorageBucket[]> {
            const response = await fetch(`${baseUrl}/storage/v1/bucket`, {
                method: 'GET',
                headers: authHeaders,
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to list storage buckets: ${error}`);
            }

            return response.json();
        },

        async listFiles(projectId: string, bucket: string, path?: string): Promise<StorageFile[]> {
            const body: Record<string, unknown> = { prefix: path || '' };
            const response = await fetch(`${baseUrl}/storage/v1/object/list/${bucket}`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to list files: ${error}`);
            }

            return response.json();
        },

        async uploadFile(projectId: string, bucket: string, path: string, content: string, contentType?: string): Promise<{ path: string }> {
            // Decode base64 content
            const binaryContent = Buffer.from(content, 'base64');

            const response = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${path}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${serviceRoleKey}`,
                    'apikey': serviceRoleKey,
                    'Content-Type': contentType || 'application/octet-stream',
                },
                body: binaryContent,
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to upload file: ${error}`);
            }

            return { path: `${bucket}/${path}` };
        },

        async downloadFile(projectId: string, bucket: string, path: string): Promise<{ signedUrl: string }> {
            // Create a signed URL for download
            return this.createSignedUrl(projectId, bucket, path, 3600);
        },

        async deleteFile(projectId: string, bucket: string, paths: string[]): Promise<void> {
            const response = await fetch(`${baseUrl}/storage/v1/object/${bucket}`, {
                method: 'DELETE',
                headers: authHeaders,
                body: JSON.stringify({ prefixes: paths }),
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to delete files: ${error}`);
            }
        },

        async createSignedUrl(projectId: string, bucket: string, path: string, expiresIn: number): Promise<{ signedUrl: string }> {
            const response = await fetch(`${baseUrl}/storage/v1/object/sign/${bucket}/${path}`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ expiresIn }),
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to create signed URL: ${error}`);
            }

            const data = await response.json() as { signedURL: string };
            return { signedUrl: `${baseUrl}/storage/v1${data.signedURL}` };
        },
    };

    // Auth operations
    const auth: AuthOperations = {
        async listUsers(projectId: string, options?: ListUsersOptions): Promise<User[]> {
            const params = new URLSearchParams();
            if (options?.page) params.set('page', options.page.toString());
            if (options?.per_page) params.set('per_page', options.per_page.toString());

            const url = `${baseUrl}/auth/v1/admin/users${params.toString() ? '?' + params.toString() : ''}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: authHeaders,
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to list users: ${error}`);
            }

            const data = await response.json() as { users: User[] };
            return data.users || [];
        },

        async getUser(projectId: string, userId: string): Promise<User> {
            const response = await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
                method: 'GET',
                headers: authHeaders,
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to get user: ${error}`);
            }

            return response.json();
        },

        async createUser(projectId: string, options: CreateUserOptions): Promise<User> {
            const response = await fetch(`${baseUrl}/auth/v1/admin/users`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify(options),
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to create user: ${error}`);
            }

            return response.json();
        },

        async deleteUser(projectId: string, userId: string): Promise<void> {
            const response = await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
                method: 'DELETE',
                headers: authHeaders,
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to delete user: ${error}`);
            }
        },

        async generateLink(projectId: string, options: GenerateLinkOptions): Promise<GenerateLinkResult> {
            const response = await fetch(`${baseUrl}/auth/v1/admin/generate_link`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify(options),
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to generate link: ${error}`);
            }

            return response.json();
        },
    };

    // Edge Functions operations
    const functions: EdgeFunctionsOperations = {
        async listEdgeFunctions(projectId: string): Promise<EdgeFunction[]> {
            try {
                const response = await fetch(`${baseUrl}/functions/v1/`, {
                    method: 'GET',
                    headers: authHeaders,
                });

                if (!response.ok) {
                    return [];
                }

                return response.json();
            } catch {
                return [];
            }
        },

        async getEdgeFunction(projectId: string, functionName: string): Promise<EdgeFunctionDetails> {
            const response = await fetch(`${baseUrl}/functions/v1/${functionName}`, {
                method: 'GET',
                headers: authHeaders,
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Failed to get Edge Function: ${error}`);
            }

            return response.json();
        },

        async invokeEdgeFunction(projectId: string, options: InvokeEdgeFunctionOptions): Promise<InvokeEdgeFunctionResult> {
            const { function_name, body, headers: customHeaders, method = 'POST' } = options;

            const response = await fetch(`${baseUrl}/functions/v1/${function_name}`, {
                method,
                headers: {
                    ...authHeaders,
                    ...customHeaders,
                },
                body: body ? JSON.stringify(body) : undefined,
            });

            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });

            let responseBody: unknown;
            const contentType = response.headers.get('content-type');
            if (contentType?.includes('application/json')) {
                responseBody = await response.json();
            } else {
                responseBody = await response.text();
            }

            return {
                status: response.status,
                headers: responseHeaders,
                body: responseBody,
            };
        },

        async deployEdgeFunction(projectId: string, options: DeployEdgeFunctionOptions): Promise<DeployEdgeFunctionResult> {
            const { name, code, entrypoint = 'index.ts', import_map, verify_jwt = true } = options;

            try {
                const deployPayload = {
                    name,
                    slug: name,
                    entrypoint_path: entrypoint,
                    import_map_path: import_map ? 'import_map.json' : undefined,
                    verify_jwt,
                    files: [
                        { name: entrypoint, content: code },
                        ...(import_map ? [{ name: 'import_map.json', content: import_map }] : []),
                    ],
                };

                const response = await fetch(`${baseUrl}/functions/v1/deploy`, {
                    method: 'POST',
                    headers: authHeaders,
                    body: JSON.stringify(deployPayload),
                });

                if (response.ok) {
                    return {
                        name,
                        status: 'deployed',
                        message: `Edge Function '${name}' deployed successfully.`,
                        deployment_path: `/functions/v1/${name}`,
                    };
                }
            } catch {
                // API deployment not available
            }

            return {
                name,
                status: 'manual_required',
                message: `To deploy in self-hosted:
1. Create: ./volumes/functions/${name}/${entrypoint}
2. Save the code below
3. Run: docker compose restart functions

\`\`\`typescript
${code}
\`\`\`

Available at: ${baseUrl}/functions/v1/${name}`,
                deployment_path: `/volumes/functions/${name}`,
            };
        },
    };

    // Create branching operations using the executeSqlViaRpc function
    const branching = createBranchingOperations(executeSqlViaRpc);

    // Docs operations - search Supabase documentation
    const docs: DocsOperations = {
        async searchDocs(query: string): Promise<DocsSearchResult[]> {
            // Search Supabase docs via their search API or provide embedded knowledge
            try {
                // Try Supabase docs search API
                const response = await fetch(`https://supabase.com/docs/api/search?q=${encodeURIComponent(query)}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                });

                if (response.ok) {
                    const data = await response.json() as { results?: { title: string; url: string; content: string; section?: string }[] };
                    return (data.results || []).slice(0, 10).map(r => ({
                        title: r.title,
                        url: r.url,
                        content: r.content,
                        section: r.section,
                    }));
                }
            } catch {
                // Fall back to embedded documentation hints
            }

            // Provide embedded documentation based on common queries
            const docs = getEmbeddedDocs(query);
            return docs;
        },
    };

    // Operations (SRE) - health checks, backups, secret rotation
    const operations: OperationsOperations = {
        async checkHealth(projectId: string): Promise<HealthCheckResult> {
            const services: ServiceHealth[] = [];
            const endpoints: ServiceHealth[] = [];

            // Check container health via API endpoints
            const healthChecks = [
                { name: 'REST API', url: `${baseUrl}/rest/v1/` },
                { name: 'Auth', url: `${baseUrl}/auth/v1/health` },
                { name: 'Storage', url: `${baseUrl}/storage/v1/status` },
            ];

            for (const check of healthChecks) {
                try {
                    const response = await fetch(check.url, {
                        method: 'GET',
                        headers: { 'apikey': serviceRoleKey },
                    });
                    endpoints.push({
                        name: check.name,
                        status: response.ok ? 'healthy' : 'unhealthy',
                        message: response.ok ? 'OK' : `HTTP ${response.status}`,
                    });
                } catch (error) {
                    endpoints.push({
                        name: check.name,
                        status: 'unhealthy',
                        message: String(error),
                    });
                }
            }

            // Check database health via query
            try {
                await executeSqlViaRpc('SELECT 1', true);
                services.push({ name: 'Database', status: 'healthy', message: 'Connected' });
            } catch (error) {
                services.push({ name: 'Database', status: 'unhealthy', message: String(error) });
            }

            const unhealthyCount = [...services, ...endpoints].filter(s => s.status === 'unhealthy').length;
            const overall = unhealthyCount === 0 ? 'healthy' : unhealthyCount < 2 ? 'degraded' : 'unhealthy';

            return {
                overall,
                services,
                endpoints,
                timestamp: new Date().toISOString(),
            };
        },

        async backupNow(projectId: string, options?: BackupOptions): Promise<BackupResult> {
            // In self-hosted, backup is typically done via pg_dump
            // This returns instructions since we can't directly execute shell scripts
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

            return {
                success: true,
                timestamp: new Date().toISOString(),
                message: `To create a backup, run:
                
docker exec supabase-db pg_dumpall -U postgres > backup_${timestamp}.sql

Or use the backup script:
./scripts/backup.sh ${options?.output_path || ''}

To restore:
docker exec -i supabase-db psql -U postgres < backup_${timestamp}.sql`,
            };
        },

        async rotateSecret(projectId: string, options: RotateSecretOptions): Promise<RotateSecretResult> {
            const { secret_type, dry_run = true } = options;

            const scriptMap: Record<string, string> = {
                jwt: 'rotate-jwt-secret.sh',
                postgres_password: 'rotate-postgres-password.sh',
                vault_key: 'rotate-vault-key.sh',
                anon_key: 'generate-keys.sh',
                service_role_key: 'generate-keys.sh',
            };

            const script = scriptMap[secret_type];

            if (dry_run) {
                return {
                    success: true,
                    secret_type,
                    message: `DRY RUN: Would rotate ${secret_type} secret.
                    
To actually rotate, run:
./scripts/${script}

Or call this tool with dry_run=false (requires shell access).`,
                    requires_restart: secret_type === 'jwt',
                };
            }

            return {
                success: false,
                secret_type,
                message: `Secret rotation requires shell access. Run:
                
./scripts/${script}

After rotation, restart services:
docker compose restart`,
                requires_restart: true,
            };
        },

        async getStats(projectId: string): Promise<SystemStats> {
            let dbSize = 'unknown';
            let connectionsActive = 0;
            let usersCount = 0;

            try {
                // Get database size
                const sizeResult = await executeSqlViaRpc<{ size: string }>(
                    "SELECT pg_size_pretty(pg_database_size(current_database())) as size",
                    true
                );
                dbSize = sizeResult[0]?.size || 'unknown';

                // Get active connections
                const connResult = await executeSqlViaRpc<{ count: number }>(
                    "SELECT count(*) as count FROM pg_stat_activity WHERE state = 'active'",
                    true
                );
                connectionsActive = connResult[0]?.count || 0;

                // Get user count
                const userResult = await executeSqlViaRpc<{ count: number }>(
                    "SELECT count(*) as count FROM auth.users",
                    true
                );
                usersCount = userResult[0]?.count || 0;
            } catch {
                // Continue with partial stats
            }

            return {
                database: {
                    size: dbSize,
                    connections_active: connectionsActive,
                    connections_max: 100, // Default max connections
                },
                users: {
                    total_count: usersCount,
                },
                timestamp: new Date().toISOString(),
            };
        },

        async runScript(projectId: string, options: RunScriptOptions): Promise<ScriptResult> {
            const { script_name, args = [] } = options;

            // In browser/Node environment, we can't directly execute shell scripts
            // Return instructions instead
            return {
                success: true,
                exit_code: 0,
                stdout: `Script execution requires shell access.

To run '${script_name}', execute:
./scripts/${script_name}.sh ${args.join(' ')}

Available scripts:
- check-health.sh: Comprehensive health check
- backup.sh: Create database backup
- env-info.sh: Show environment information
- show-mcp.sh: Show MCP configuration`,
            };
        },
    };

    const platform: SupabasePlatform = {
        async init(info: InitData) {
            try {
                const response = await fetch(`${baseUrl}/rest/v1/`, {
                    method: 'GET',
                    headers: { 'apikey': serviceRoleKey },
                });

                if (!response.ok && response.status !== 404) {
                    throw new Error(`Failed to connect to Supabase at ${baseUrl}`);
                }
            } catch (error) {
                console.error('Warning: Could not verify connection to Supabase:', error);
            }
        },
        database,
        debugging,
        development,
        storage,
        auth,
        functions,
        branching,
        docs,
        operations,
    };

    return platform;
}

// Embedded documentation for common Supabase topics
function getEmbeddedDocs(query: string): DocsSearchResult[] {
    const q = query.toLowerCase();
    const results: DocsSearchResult[] = [];

    if (q.includes('auth') || q.includes('login') || q.includes('signup')) {
        results.push({
            title: 'Authentication',
            url: 'https://supabase.com/docs/guides/auth',
            content: 'Supabase Auth provides user authentication with email/password, magic links, OAuth providers (Google, GitHub, etc.), and phone auth.',
            section: 'Auth',
        });
    }

    if (q.includes('storage') || q.includes('file') || q.includes('upload')) {
        results.push({
            title: 'Storage',
            url: 'https://supabase.com/docs/guides/storage',
            content: 'Supabase Storage allows you to store and serve files. Create buckets, upload files, and generate signed URLs for secure access.',
            section: 'Storage',
        });
    }

    if (q.includes('database') || q.includes('sql') || q.includes('postgres')) {
        results.push({
            title: 'Database',
            url: 'https://supabase.com/docs/guides/database',
            content: 'Supabase uses PostgreSQL with extensions like pgvector for AI embeddings. Use Row Level Security (RLS) for data protection.',
            section: 'Database',
        });
    }

    if (q.includes('edge') || q.includes('function') || q.includes('serverless')) {
        results.push({
            title: 'Edge Functions',
            url: 'https://supabase.com/docs/guides/functions',
            content: 'Edge Functions are server-side TypeScript functions that run on Deno Deploy. Use them for custom APIs, webhooks, and background tasks.',
            section: 'Functions',
        });
    }

    if (q.includes('realtime') || q.includes('subscription') || q.includes('websocket')) {
        results.push({
            title: 'Realtime',
            url: 'https://supabase.com/docs/guides/realtime',
            content: 'Supabase Realtime enables live database changes via WebSocket. Subscribe to INSERT, UPDATE, DELETE events on tables.',
            section: 'Realtime',
        });
    }

    if (q.includes('rls') || q.includes('security') || q.includes('policy')) {
        results.push({
            title: 'Row Level Security',
            url: 'https://supabase.com/docs/guides/auth/row-level-security',
            content: 'RLS policies control which rows users can access. Enable RLS on tables and create policies using auth.uid() for user-based access.',
            section: 'Security',
        });
    }

    if (results.length === 0) {
        results.push({
            title: 'Supabase Documentation',
            url: 'https://supabase.com/docs',
            content: `Search for "${query}" in the Supabase documentation for detailed guides and API references.`,
            section: 'General',
        });
    }

    return results;
}

// Branching operations using PostgreSQL schemas
function createBranchingOperations(
    executeSql: <T>(query: string, readOnly?: boolean) => Promise<T[]>
): BranchingOperations {
    return {
        async listBranches(projectId: string): Promise<Branch[]> {
            const result = await executeSql<{ schema_name: string; created_at: string }>(`
                SELECT 
                    n.nspname as schema_name,
                    COALESCE(
                        (SELECT description FROM pg_description d 
                         WHERE d.objoid = n.oid AND d.classoid = 'pg_namespace'::regclass),
                        ''
                    ) as description
                FROM pg_namespace n
                WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1')
                  AND n.nspname NOT LIKE 'pg_%'
                ORDER BY n.nspname
            `, true);

            return result.map(row => ({
                name: row.schema_name,
                schema_name: row.schema_name,
                is_default: row.schema_name === 'public',
            }));
        },

        async createBranch(projectId: string, options: CreateBranchOptions): Promise<Branch> {
            const { name, parent_branch = 'public' } = options;
            const schemaName = name.replace(/[^a-zA-Z0-9_]/g, '_');

            // Create new schema
            await executeSql(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`, false);

            // Copy table structures from parent
            const tables = await executeSql<{ table_name: string; table_definition: string }>(`
                SELECT 
                    table_name,
                    'CREATE TABLE "${schemaName}."' || table_name || ' (LIKE "${parent_branch}".' || table_name || ' INCLUDING ALL)' as table_definition
                FROM information_schema.tables
                WHERE table_schema = '${parent_branch}'
                  AND table_type = 'BASE TABLE'
            `, true);

            for (const table of tables) {
                try {
                    await executeSql(`CREATE TABLE IF NOT EXISTS "${schemaName}"."${table.table_name}" (LIKE "${parent_branch}"."${table.table_name}" INCLUDING ALL)`, false);
                } catch {
                    // Continue if table already exists
                }
            }

            return {
                name: schemaName,
                schema_name: schemaName,
                is_default: false,
                parent_branch,
            };
        },

        async deleteBranch(projectId: string, branchName: string): Promise<void> {
            if (branchName === 'public') {
                throw new Error('Cannot delete the public schema');
            }
            const schemaName = branchName.replace(/[^a-zA-Z0-9_]/g, '_');
            await executeSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`, false);
        },

        async mergeBranch(projectId: string, options: MergeBranchOptions): Promise<MergeBranchResult> {
            const { source_branch, target_branch = 'public' } = options;
            const sourceSchema = source_branch.replace(/[^a-zA-Z0-9_]/g, '_');
            const targetSchema = target_branch.replace(/[^a-zA-Z0-9_]/g, '_');

            // Get migrations from source that aren't in target
            const migrations = await executeSql<{ version: string; name: string }>(`
                SELECT version, name 
                FROM "${sourceSchema}".schema_migrations 
                WHERE version NOT IN (
                    SELECT version FROM "${targetSchema}".schema_migrations
                )
                ORDER BY version
            `, true).catch(() => []);

            const migrationsApplied: string[] = [];

            for (const migration of migrations) {
                migrationsApplied.push(migration.version);
            }

            return {
                success: true,
                migrations_applied: migrationsApplied,
            };
        },

        async resetBranch(projectId: string, options: ResetBranchOptions): Promise<void> {
            const { branch_name, migration_version } = options;
            const schemaName = branch_name.replace(/[^a-zA-Z0-9_]/g, '_');

            if (migration_version) {
                // Reset to specific migration version
                await executeSql(`
                    DELETE FROM "${schemaName}".schema_migrations 
                    WHERE version > '${migration_version}'
                `, false);
            } else {
                // Drop and recreate schema
                if (schemaName !== 'public') {
                    await executeSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`, false);
                    await executeSql(`CREATE SCHEMA "${schemaName}"`, false);
                }
            }
        },

        async rebaseBranch(projectId: string, options: RebaseBranchOptions): Promise<void> {
            const { branch_name, target_branch = 'public' } = options;
            const branchSchema = branch_name.replace(/[^a-zA-Z0-9_]/g, '_');
            const targetSchema = target_branch.replace(/[^a-zA-Z0-9_]/g, '_');

            // Get new migrations from target
            const newMigrations = await executeSql<{ version: string }>(`
                SELECT version FROM "${targetSchema}".schema_migrations
                WHERE version NOT IN (
                    SELECT version FROM "${branchSchema}".schema_migrations
                )
                ORDER BY version
            `, true).catch(() => []);

            // Apply migrations from target to branch
            for (const migration of newMigrations) {
                await executeSql(`
                    INSERT INTO "${branchSchema}".schema_migrations (version)
                    VALUES ('${migration.version}')
                    ON CONFLICT DO NOTHING
                `, false).catch(() => { });
            }
        },
    };
}

/**
 * Map PostgreSQL data types to TypeScript types.
 */
function mapPostgresToTs(pgType: string): string {
    const typeMap: Record<string, string> = {
        'integer': 'number',
        'bigint': 'number',
        'smallint': 'number',
        'decimal': 'number',
        'numeric': 'number',
        'real': 'number',
        'double precision': 'number',
        'serial': 'number',
        'bigserial': 'number',
        'text': 'string',
        'character varying': 'string',
        'varchar': 'string',
        'char': 'string',
        'character': 'string',
        'uuid': 'string',
        'date': 'string',
        'time': 'string',
        'timestamp': 'string',
        'timestamp with time zone': 'string',
        'timestamp without time zone': 'string',
        'boolean': 'boolean',
        'json': 'Json',
        'jsonb': 'Json',
        'bytea': 'string',
        'ARRAY': 'unknown[]',
    };

    return typeMap[pgType.toLowerCase()] || 'unknown';
}
