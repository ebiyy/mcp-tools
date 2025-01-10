#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  throw new Error("GITHUB_TOKEN environment variable is required");
}

const octokit = new Octokit({
  auth: GITHUB_TOKEN
});

const server = new Server(
  {
    name: "github-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// リポジトリ情報をキャッシュするオブジェクト
const repoCache: { [fullName: string]: any } = {};

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const { data: repos } = await octokit.repos.listForAuthenticatedUser({
      sort: 'updated',
      per_page: 10
    });

    // キャッシュを更新
    for (const repo of repos) {
      repoCache[repo.full_name] = repo;
    }

    return {
      resources: repos.map(repo => ({
        uri: `github://repo/${repo.full_name}`,
        mimeType: "application/json",
        name: repo.full_name,
        description: repo.description || `Repository: ${repo.full_name}`
      }))
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to list repositories: ${error}`);
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const match = request.params.uri.match(/^github:\/\/repo\/([^/]+\/[^/]+)$/);
  if (!match) {
    throw new McpError(ErrorCode.InvalidRequest, `Invalid repository URI: ${request.params.uri}`);
  }

  const fullName = match[1];
  try {
    let repo = repoCache[fullName];
    if (!repo) {
      const [owner, name] = fullName.split('/');
      const { data } = await octokit.repos.get({ owner, repo: name });
      repo = data;
      repoCache[fullName] = repo;
    }

    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(repo, null, 2)
      }]
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to get repository: ${error}`);
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_repository",
        description: "Create a new GitHub repository",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Repository name"
            },
            description: {
              type: "string",
              description: "Repository description"
            },
            private: {
              type: "boolean",
              description: "Whether the repository should be private",
              default: false
            }
          },
          required: ["name"]
        }
      },
      {
        name: "create_commit",
        description: "Create a commit in a repository",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "Repository full name (owner/repo)"
            },
            path: {
              type: "string",
              description: "File path"
            },
            content: {
              type: "string",
              description: "File content"
            },
            message: {
              type: "string",
              description: "Commit message"
            },
            branch: {
              type: "string",
              description: "Branch name",
              default: "main"
            }
          },
          required: ["repo", "path", "content", "message"]
        }
      },
      {
        name: "create_pull_request",
        description: "Create a pull request",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "Repository full name (owner/repo)"
            },
            title: {
              type: "string",
              description: "Pull request title"
            },
            body: {
              type: "string",
              description: "Pull request description"
            },
            head: {
              type: "string",
              description: "The name of the branch where your changes are implemented"
            },
            base: {
              type: "string",
              description: "The name of the branch you want your changes pulled into",
              default: "main"
            }
          },
          required: ["repo", "title", "head"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "create_repository": {
      const { name, description, private: isPrivate } = request.params.arguments as any;
      try {
        const { data: repo } = await octokit.repos.createForAuthenticatedUser({
          name,
          description,
          private: isPrivate
        });

        return {
          content: [{
            type: "text",
            text: `Created repository: ${repo.html_url}`
          }]
        };
      } catch (error) {
        throw new McpError(ErrorCode.InternalError, `Failed to create repository: ${error}`);
      }
    }

    case "create_commit": {
      const { repo, path, content, message, branch } = request.params.arguments as any;
      const [owner, repoName] = repo.split('/');

      try {
        // Get the current commit SHA
        const { data: ref } = await octokit.git.getRef({
          owner,
          repo: repoName,
          ref: `heads/${branch}`
        });

        // Create blob with file content
        const { data: blob } = await octokit.git.createBlob({
          owner,
          repo: repoName,
          content: Buffer.from(content).toString('base64'),
          encoding: 'base64'
        });

        // Create tree
        const { data: tree } = await octokit.git.createTree({
          owner,
          repo: repoName,
          base_tree: ref.object.sha,
          tree: [{
            path,
            mode: '100644',
            type: 'blob',
            sha: blob.sha
          }]
        });

        // Create commit
        const { data: commit } = await octokit.git.createCommit({
          owner,
          repo: repoName,
          message,
          tree: tree.sha,
          parents: [ref.object.sha]
        });

        // Update branch reference
        await octokit.git.updateRef({
          owner,
          repo: repoName,
          ref: `heads/${branch}`,
          sha: commit.sha
        });

        return {
          content: [{
            type: "text",
            text: `Created commit: ${commit.sha}`
          }]
        };
      } catch (error) {
        throw new McpError(ErrorCode.InternalError, `Failed to create commit: ${error}`);
      }
    }

    case "create_pull_request": {
      const { repo, title, body, head, base } = request.params.arguments as any;
      const [owner, repoName] = repo.split('/');

      try {
        const { data: pr } = await octokit.pulls.create({
          owner,
          repo: repoName,
          title,
          body,
          head,
          base
        });

        return {
          content: [{
            type: "text",
            text: `Created pull request: ${pr.html_url}`
          }]
        };
      } catch (error) {
        throw new McpError(ErrorCode.InternalError, `Failed to create pull request: ${error}`);
      }
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, "Unknown tool");
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitHub MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
