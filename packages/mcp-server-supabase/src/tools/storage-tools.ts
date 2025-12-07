import { z } from 'zod';
import type { StorageOperations, DatabaseOperations } from '../platform/types.js';
import { injectableTool } from './util.js';

const SUCCESS_RESPONSE = { success: true };

export type StorageToolsOptions = {
  storage: StorageOperations;
  database?: DatabaseOperations;
  projectId?: string;
  readOnly?: boolean;
};

export function getStorageTools({
  storage,
  database,
  projectId,
  readOnly,
}: StorageToolsOptions) {
  const project_id = projectId;

  return {
    // Bucket Creation via SQL (workaround for self-hosted)
    create_storage_bucket: injectableTool({
      description: `Creates a new storage bucket in Supabase.

**Important for Self-Hosted Supabase:**
This tool creates buckets by inserting directly into the storage.buckets table via SQL.
This is the recommended method for self-hosted instances where the Storage API may have authentication issues.

**Parameters:**
- name: Unique bucket name (lowercase, no spaces)
- public: Whether the bucket should be publicly accessible (default: false)
- file_size_limit: Max file size in bytes (optional, e.g., 52428800 for 50MB)
- allowed_mime_types: Array of allowed MIME types (optional, e.g., ["image/png", "image/jpeg"])`,
      annotations: {
        title: 'Create storage bucket',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      parameters: z.object({
        project_id: z.string(),
        name: z.string().describe('Unique bucket name (lowercase, no spaces)'),
        public: z.boolean().default(false).describe('Whether the bucket is publicly accessible'),
        file_size_limit: z.number().optional().describe('Maximum file size in bytes'),
        allowed_mime_types: z.array(z.string()).optional().describe('Allowed MIME types'),
      }),
      inject: { project_id },
      execute: async ({ project_id, name, public: isPublic, file_size_limit, allowed_mime_types }) => {
        if (readOnly) {
          throw new Error('Cannot create bucket in read-only mode.');
        }

        if (!database) {
          throw new Error('Database operations not available. Cannot create bucket via SQL.');
        }

        // Build the INSERT query for storage.buckets
        const mimeTypesValue = allowed_mime_types
          ? `ARRAY[${allowed_mime_types.map(t => `'${t}'`).join(', ')}]::text[]`
          : 'NULL';

        const fileSizeLimitValue = file_size_limit !== undefined ? file_size_limit : 'NULL';

        const query = `
          INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at)
          VALUES (
            '${name}',
            '${name}',
            ${isPublic},
            ${fileSizeLimitValue},
            ${mimeTypesValue},
            NOW(),
            NOW()
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id, name, public, file_size_limit, allowed_mime_types, created_at;
        `;

        try {
          const result = await database.executeSql(project_id, { query, read_only: false });

          if (Array.isArray(result) && result.length > 0) {
            return {
              success: true,
              bucket: result[0],
              message: `Bucket '${name}' created successfully.`
            };
          }

          // Check if bucket already exists
          const checkQuery = `SELECT id, name, public FROM storage.buckets WHERE id = '${name}'`;
          const existing = await database.executeSql(project_id, { query: checkQuery, read_only: true });

          if (Array.isArray(existing) && existing.length > 0) {
            return {
              success: true,
              bucket: existing[0],
              message: `Bucket '${name}' already exists.`
            };
          }

          return {
            success: true,
            message: `Bucket '${name}' created (or already existed).`
          };
        } catch (error) {
          throw new Error(`Failed to create bucket '${name}': ${error}`);
        }
      },
    }),

    list_storage_buckets: injectableTool({
      description: 'Lists all storage buckets in a Supabase project.',
      annotations: {
        title: 'List storage buckets',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      parameters: z.object({
        project_id: z.string(),
      }),
      inject: { project_id },
      execute: async ({ project_id }) => {
        // Try SQL first for self-hosted reliability
        if (database) {
          try {
            const query = `SELECT id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at FROM storage.buckets ORDER BY created_at`;
            const result = await database.executeSql(project_id, { query, read_only: true });
            return result;
          } catch {
            // Fallback to API
          }
        }
        return await storage.listAllBuckets(project_id);
      },
    }),

    get_storage_config: injectableTool({
      description: 'Get the storage config for a Supabase project.',
      annotations: {
        title: 'Get storage config',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      parameters: z.object({
        project_id: z.string(),
      }),
      inject: { project_id },
      execute: async ({ project_id }) => {
        return await storage.getStorageConfig(project_id);
      },
    }),

    update_storage_config: injectableTool({
      description: 'Update the storage config for a Supabase project.',
      annotations: {
        title: 'Update storage config',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      parameters: z.object({
        project_id: z.string(),
        config: z.object({
          fileSizeLimit: z.number(),
          features: z.object({
            imageTransformation: z.object({ enabled: z.boolean() }),
            s3Protocol: z.object({ enabled: z.boolean() }),
          }),
        }),
      }),
      inject: { project_id },
      execute: async ({ project_id, config }) => {
        if (readOnly) {
          throw new Error('Cannot update storage config in read-only mode.');
        }

        await storage.updateStorageConfig(project_id, config);
        return SUCCESS_RESPONSE;
      },
    }),

    // File Management Tools
    list_files: injectableTool({
      description: 'Lists all files in a storage bucket.',
      annotations: {
        title: 'List files',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      parameters: z.object({
        project_id: z.string(),
        bucket: z.string().describe('Name of the storage bucket'),
        path: z.string().optional().describe('Path prefix to filter files'),
      }),
      inject: { project_id },
      execute: async ({ project_id, bucket, path }) => {
        return await storage.listFiles(project_id, bucket, path);
      },
    }),

    upload_file: injectableTool({
      description: 'Uploads a file to a storage bucket. Content should be base64 encoded.',
      annotations: {
        title: 'Upload file',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      parameters: z.object({
        project_id: z.string(),
        bucket: z.string().describe('Name of the storage bucket'),
        path: z.string().describe('Path where the file will be stored'),
        content: z.string().describe('Base64 encoded file content'),
        content_type: z.string().optional().describe('MIME type of the file (e.g., image/png)'),
      }),
      inject: { project_id },
      execute: async ({ project_id, bucket, path, content, content_type }) => {
        if (readOnly) {
          throw new Error('Cannot upload file in read-only mode.');
        }
        return await storage.uploadFile(project_id, bucket, path, content, content_type);
      },
    }),

    download_file: injectableTool({
      description: 'Gets a signed URL to download a file from storage.',
      annotations: {
        title: 'Download file',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      parameters: z.object({
        project_id: z.string(),
        bucket: z.string().describe('Name of the storage bucket'),
        path: z.string().describe('Path to the file'),
      }),
      inject: { project_id },
      execute: async ({ project_id, bucket, path }) => {
        return await storage.downloadFile(project_id, bucket, path);
      },
    }),

    delete_file: injectableTool({
      description: 'Deletes one or more files from a storage bucket.',
      annotations: {
        title: 'Delete file',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      parameters: z.object({
        project_id: z.string(),
        bucket: z.string().describe('Name of the storage bucket'),
        paths: z.array(z.string()).describe('Array of file paths to delete'),
      }),
      inject: { project_id },
      execute: async ({ project_id, bucket, paths }) => {
        if (readOnly) {
          throw new Error('Cannot delete files in read-only mode.');
        }
        await storage.deleteFile(project_id, bucket, paths);
        return SUCCESS_RESPONSE;
      },
    }),

    create_signed_url: injectableTool({
      description: 'Creates a signed URL for temporary access to a file.',
      annotations: {
        title: 'Create signed URL',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      parameters: z.object({
        project_id: z.string(),
        bucket: z.string().describe('Name of the storage bucket'),
        path: z.string().describe('Path to the file'),
        expires_in: z.number().describe('Expiration time in seconds (e.g., 3600 for 1 hour)'),
      }),
      inject: { project_id },
      execute: async ({ project_id, bucket, path, expires_in }) => {
        return await storage.createSignedUrl(project_id, bucket, path, expires_in);
      },
    }),
  };
}
