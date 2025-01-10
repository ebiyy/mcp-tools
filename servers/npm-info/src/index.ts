#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import npmFetch from 'npm-registry-fetch';
import { PackageInfoArgs, ReleaseHistoryArgs, DependencyAnalysisArgs } from './types.js';

class NpmInfoServer {
  private server: Server;
  private npmRegistry = 'https://registry.npmjs.org';

  constructor() {
    this.server = new Server(
      {
        name: "npm-info-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    this.setupToolHandlers();
    
    this.server.onerror = (error: Error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_package_info',
          description: 'パッケージの最新情報を取得します',
          inputSchema: {
            type: 'object',
            properties: {
              packageName: {
                type: 'string',
                description: 'npmパッケージ名',
              },
            },
            required: ['packageName'],
          },
        },
        {
          name: 'get_release_history',
          description: 'パッケージのリリース履歴を取得します',
          inputSchema: {
            type: 'object',
            properties: {
              packageName: {
                type: 'string',
                description: 'npmパッケージ名',
              },
              limit: {
                type: 'number',
                description: '取得する履歴の数',
                default: 5,
              },
            },
            required: ['packageName'],
          },
        },
        {
          name: 'analyze_dependencies',
          description: 'パッケージの依存関係を分析します',
          inputSchema: {
            type: 'object',
            properties: {
              packageName: {
                type: 'string',
                description: 'npmパッケージ名',
              },
            },
            required: ['packageName'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const args = request.params.arguments as Record<string, unknown>;
        if (!args) {
          throw new McpError(ErrorCode.InvalidParams, '引数が必要です');
        }

        switch (request.params.name) {
          case 'get_package_info': {
            const validArgs: PackageInfoArgs = {
              packageName: String(args.packageName),
            };
            return await this.getPackageInfo(validArgs);
          }
          case 'get_release_history': {
            const validArgs: ReleaseHistoryArgs = {
              packageName: String(args.packageName),
              limit: args.limit ? Number(args.limit) : undefined,
            };
            return await this.getReleaseHistory(validArgs);
          }
          case 'analyze_dependencies': {
            const validArgs: DependencyAnalysisArgs = {
              packageName: String(args.packageName),
            };
            return await this.analyzeDependencies(validArgs);
          }
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: 'text',
                text: `NPM API error: ${error.message}`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  private async getPackageInfo(args: PackageInfoArgs) {
    if (!args.packageName || typeof args.packageName !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'パッケージ名が必要です');
    }

    const info = await npmFetch.json(args.packageName);
    const latestVersion = info['dist-tags'].latest;
    const latest = info.versions[latestVersion];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            name: info.name,
            version: latestVersion,
            description: latest.description,
            author: latest.author,
            homepage: latest.homepage,
            repository: latest.repository,
            dependencies: latest.dependencies,
            devDependencies: latest.devDependencies,
          }, null, 2),
        },
      ],
    };
  }

  private async getReleaseHistory(args: ReleaseHistoryArgs) {
    if (!args.packageName || typeof args.packageName !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'パッケージ名が必要です');
    }

    const limit = args.limit || 5;
    const info = await npmFetch.json(args.packageName);
    const versions = Object.entries(info.time)
      .filter(([version]) => version !== 'created' && version !== 'modified')
      .sort(([, dateA], [, dateB]) => {
        const dateATime = new Date(dateA as string).getTime();
        const dateBTime = new Date(dateB as string).getTime();
        return dateBTime - dateATime;
      })
      .slice(0, limit)
      .map(([version]) => version);

    const history = versions.map(version => ({
      version,
      date: info.time[version],
      changes: info.versions[version].description || 'No description available',
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(history, null, 2),
        },
      ],
    };
  }

  private async analyzeDependencies(args: DependencyAnalysisArgs) {
    if (!args.packageName || typeof args.packageName !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'パッケージ名が必要です');
    }

    const info = await npmFetch.json(args.packageName);
    const latestVersion = info['dist-tags'].latest;
    const latest = info.versions[latestVersion];

    const analysis = {
      dependencies: Object.keys(latest.dependencies || {}).length,
      devDependencies: Object.keys(latest.devDependencies || {}).length,
      peerDependencies: Object.keys(latest.peerDependencies || {}).length,
      details: {
        dependencies: latest.dependencies || {},
        devDependencies: latest.devDependencies || {},
        peerDependencies: latest.peerDependencies || {},
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(analysis, null, 2),
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('NPM Info MCP server running on stdio');
  }
}

const server = new NpmInfoServer();
server.run().catch(console.error);
