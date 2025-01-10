#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import * as Effect from '@effect/io/Effect';

// メモリストアのインターフェース
interface MemoryStore {
  readonly set: (key: string, value: string) => Effect.Effect<never, never, void>;
  readonly get: (key: string) => Effect.Effect<never, McpError, string>;
  readonly delete: (key: string) => Effect.Effect<never, McpError, void>;
  readonly list: () => Effect.Effect<never, never, Record<string, string>>;
}

// メモリストアの実装
class MemoryStoreImpl implements MemoryStore {
  private store: Map<string, string>;

  constructor() {
    this.store = new Map();
  }

  set(key: string, value: string): Effect.Effect<never, never, void> {
    return Effect.sync(() => {
      this.store.set(key, value);
    });
  }

  get(key: string): Effect.Effect<never, McpError, string> {
    return Effect.sync(() => {
      const value = this.store.get(key);
      if (value === undefined) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `キーが見つかりません: ${key}`
        );
      }
      return value;
    });
  }

  delete(key: string): Effect.Effect<never, McpError, void> {
    return Effect.sync(() => {
      if (!this.store.has(key)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `キーが見つかりません: ${key}`
        );
      }
      this.store.delete(key);
    });
  }

  list(): Effect.Effect<never, never, Record<string, string>> {
    return Effect.sync(() => {
      return Object.fromEntries(this.store.entries());
    });
  }
}

class MemoryServer {
  private server: Server;
  private memoryStore: MemoryStoreImpl;

  constructor() {
    this.server = new Server(
      {
        name: 'server-memory',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.memoryStore = new MemoryStoreImpl();
    this.setupToolHandlers();
    
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'set_value',
          description: '指定されたキーに値を保存します',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: '保存するキー',
              },
              value: {
                type: 'string',
                description: '保存する値',
              },
            },
            required: ['key', 'value'],
          },
        },
        {
          name: 'get_value',
          description: '指定されたキーの値を取得します',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: '取得するキー',
              },
            },
            required: ['key'],
          },
        },
        {
          name: 'delete_value',
          description: '指定されたキーの値を削除します',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: '削除するキー',
              },
            },
            required: ['key'],
          },
        },
        {
          name: 'list_values',
          description: '保存されているすべてのキーと値を取得します',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const handleEffect = <E, A>(
        effect: Effect.Effect<never, E, A>,
        successMessage?: string
      ) => {
        return Effect.runSync(effect.pipe(
          Effect.map((result) => ({
            content: [
              {
                type: 'text',
                text: successMessage ? successMessage : JSON.stringify(result, null, 2),
              },
            ],
          }))
        ));
      };

      switch (request.params.name) {
        case 'set_value': {
          const { key, value } = request.params.arguments as { key: string; value: string };
          return handleEffect(
            this.memoryStore.set(key, value),
            `値を保存しました: ${key} = ${value}`
          );
        }

        case 'get_value': {
          const { key } = request.params.arguments as { key: string };
          return handleEffect(this.memoryStore.get(key));
        }

        case 'delete_value': {
          const { key } = request.params.arguments as { key: string };
          return handleEffect(
            this.memoryStore.delete(key),
            `値を削除しました: ${key}`
          );
        }

        case 'list_values': {
          return handleEffect(this.memoryStore.list());
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `不明なツール: ${request.params.name}`
          );
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Memory MCP server running on stdio');
  }
}

const server = new MemoryServer();
server.run().catch(console.error);
