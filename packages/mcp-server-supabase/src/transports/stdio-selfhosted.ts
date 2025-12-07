#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import packageJson from '../../package.json' with { type: 'json' };
import { createSelfHostedPlatform } from '../platform/selfhosted-platform.js';
import { createSupabaseMcpServer } from '../server.js';
import { parseList } from './util.js';

const { version } = packageJson;

async function main() {
    const {
        values: {
            ['supabase-url']: cliSupabaseUrl,
            ['service-role-key']: cliServiceRoleKey,
            ['anon-key']: cliAnonKey,
            ['read-only']: readOnly,
            ['version']: showVersion,
            ['features']: cliFeatures,
        },
    } = parseArgs({
        options: {
            ['supabase-url']: {
                type: 'string',
                description: 'Self-hosted Supabase URL (e.g., http://localhost or https://supabase.example.com)',
            },
            ['service-role-key']: {
                type: 'string',
                description: 'Service role key for authentication',
            },
            ['anon-key']: {
                type: 'string',
                description: 'Optional anon key for client-safe operations',
            },
            ['read-only']: {
                type: 'boolean',
                default: false,
                description: 'Run in read-only mode (no write operations)',
            },
            ['version']: {
                type: 'boolean',
                description: 'Show version number',
            },
            ['features']: {
                type: 'string',
                description: 'Comma-separated list of features to enable',
            },
        },
    });

    if (showVersion) {
        // Use stderr to avoid stdout pollution (Windows CRLF bug workaround)
        console.error(`${version} (self-hosted)`);
        process.exit(0);
    }

    // Get configuration from CLI args or environment variables
    const supabaseUrl = cliSupabaseUrl ?? process.env.SUPABASE_URL;
    const serviceRoleKey = cliServiceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = cliAnonKey ?? process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl) {
        console.error(
            'Please provide the Supabase URL with --supabase-url flag or set the SUPABASE_URL environment variable'
        );
        process.exit(1);
    }

    if (!serviceRoleKey) {
        console.error(
            'Please provide the service role key with --service-role-key flag or set the SUPABASE_SERVICE_ROLE_KEY environment variable'
        );
        process.exit(1);
    }

    const features = cliFeatures ? parseList(cliFeatures) : undefined;

    // Create self-hosted platform
    const platform = createSelfHostedPlatform({
        supabaseUrl,
        serviceRoleKey,
        anonKey,
    });

    // Create MCP server with self-hosted platform
    const server = createSupabaseMcpServer({
        platform,
        // In self-hosted mode, there's only one project, so we use 'default' as the project ID
        projectId: 'default',
        readOnly,
        features,
    });

    const transport = new StdioServerTransport();

    console.error(`Starting Supabase MCP Server (self-hosted mode) v${version}`);
    console.error(`Connecting to: ${supabaseUrl}`);

    await server.connect(transport);
}

main().catch((error) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
});
