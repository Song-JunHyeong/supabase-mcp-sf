import {
  createMcpServer,
  type Tool,
  type ToolCallCallback,
} from './mcp-utils/server.js';
import packageJson from '../package.json' with { type: 'json' };
import type { SupabasePlatform } from './platform/types.js';
import { getAuthTools } from './tools/auth-tools.js';
import { getBranchingTools } from './tools/branching-tools.js';
import { getDatabaseTools } from './tools/database-operation-tools.js';
import { getDebuggingTools } from './tools/debugging-tools.js';
import { getDevelopmentTools } from './tools/development-tools.js';
import { getDocsTools } from './tools/docs-tools.js';
import { getEdgeFunctionTools } from './tools/edge-function-tools.js';
import { getOperationsTools } from './tools/operations-tools.js';
import { getStorageTools } from './tools/storage-tools.js';
import type { FeatureGroup } from './types.js';

const { version } = packageJson;

export type SupabaseMcpServerOptions = {
  /**
   * Platform implementation for Supabase.
   */
  platform: SupabasePlatform;

  /**
   * The project ID to scope the server to.
   * For self-hosted, this defaults to 'default'.
   */
  projectId?: string;

  /**
   * Executes database queries in read-only mode if true.
   */
  readOnly?: boolean;

  /**
   * Features to enable.
   * Options: 'database', 'debugging', 'development', 'storage', 'auth', 'functions', 'branching', 'docs', 'operations'
   */
  features?: string[];

  /**
   * Callback for after a supabase tool is called.
   */
  onToolCall?: ToolCallCallback;
};

// Self-hosted available features
const SELFHOSTED_FEATURES: FeatureGroup[] = [
  'database',
  'debugging',
  'development',
  'storage',
  'auth',
  'functions',
  'branching',
  'docs',
  'operations',
];

/**
 * Creates an MCP server for interacting with self-hosted Supabase.
 */
export function createSupabaseMcpServer(options: SupabaseMcpServerOptions) {
  const {
    platform,
    projectId = 'default',
    readOnly,
    features,
    onToolCall,
  } = options;

  // Filter features based on what's available
  const enabledFeatures = new Set<FeatureGroup>(
    (features as FeatureGroup[] | undefined) ?? SELFHOSTED_FEATURES
  );

  const server = createMcpServer({
    name: 'supabase-mcp-sf',
    title: 'Supabase MCP (Self-Hosted)',
    version,
    async onInitialize(info) {
      await platform.init?.(info);
    },
    onToolCall,
    tools: async () => {
      const tools: Record<string, Tool> = {};

      const {
        database,
        debugging,
        development,
        storage,
        auth,
        functions,
        branching,
        docs,
        operations,
      } = platform;

      if (database && enabledFeatures.has('database')) {
        Object.assign(
          tools,
          getDatabaseTools({
            database,
            projectId,
            readOnly,
          })
        );
      }

      if (debugging && enabledFeatures.has('debugging')) {
        Object.assign(tools, getDebuggingTools({ debugging, projectId }));
      }

      if (development && enabledFeatures.has('development')) {
        Object.assign(tools, getDevelopmentTools({ development, projectId }));
      }

      if (storage && enabledFeatures.has('storage')) {
        Object.assign(tools, getStorageTools({ storage, database, projectId, readOnly }));
      }

      if (auth && enabledFeatures.has('auth')) {
        Object.assign(tools, getAuthTools({ auth, projectId, readOnly }));
      }

      if (functions && enabledFeatures.has('functions')) {
        Object.assign(tools, getEdgeFunctionTools({ functions, projectId, readOnly }));
      }

      if (branching && enabledFeatures.has('branching')) {
        Object.assign(tools, getBranchingTools({ branching, projectId, readOnly }));
      }

      if (docs && enabledFeatures.has('docs')) {
        Object.assign(tools, getDocsTools({ docs }));
      }

      if (operations && enabledFeatures.has('operations')) {
        Object.assign(tools, getOperationsTools({ operations, projectId, readOnly }));
      }

      return tools;
    },
  });

  return server;
}
