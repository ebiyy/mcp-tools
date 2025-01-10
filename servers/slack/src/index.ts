#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from "@slack/web-api";
import * as Effect from "@effect/io/Effect";
import * as Layer from "@effect/io/Layer";
import * as Context from "@effect/data/Context";
import * as Duration from "@effect/data/Duration";
import { pipe } from "@effect/data/Function";
import { z } from 'zod';

const SLACK_TOKEN = process.env.SLACK_TOKEN;
if (!SLACK_TOKEN) {
  throw new Error("SLACK_TOKEN environment variable is required");
}

// Types and Schemas
const SendMessageSchema = z.object({
  channel: z.string(),
  text: z.string()
});

const ListChannelsSchema = z.object({
  limit: z.number().optional()
});

const ListUsersSchema = z.object({
  limit: z.number().optional()
});

const GetLatestMessageSchema = z.object({
  channel: z.string()
});

type SendMessageArgs = z.infer<typeof SendMessageSchema>;
type ListChannelsArgs = z.infer<typeof ListChannelsSchema>;
type ListUsersArgs = z.infer<typeof ListUsersSchema>;
type GetLatestMessageArgs = z.infer<typeof GetLatestMessageSchema>;

// Error types
class SlackError extends Error {
  readonly _tag = 'SlackError';
  constructor(message: string) {
    super(message);
    this.name = 'SlackError';
  }
}

// Response types
interface ChannelInfo {
  id: string;
  name: string;
  is_private: boolean;
  num_members?: number;
}

interface MessageResponse {
  text?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
}

// Service interfaces
class SlackApi {
  readonly _tag = 'SlackApi' as const;
  constructor(readonly client: WebClient) {}
}

const SlackApiTag = Context.Tag<SlackApi>();

interface SlackService {
  readonly sendMessage: (args: SendMessageArgs) => Effect.Effect<never, SlackError, { status: string; ts: string; channel: string }>;
  readonly listChannels: (args: ListChannelsArgs) => Effect.Effect<never, SlackError, { channels: ChannelInfo[] }>;
  readonly listUsers: (args: ListUsersArgs) => Effect.Effect<never, SlackError, { users: Array<{ id: string; name: string; real_name?: string; is_bot?: boolean }> }>;
  readonly getLatestMessage: (args: GetLatestMessageArgs) => Effect.Effect<never, SlackError, MessageResponse>;
}

const SlackServiceTag = Context.Tag<SlackService>();

// Layer implementations
const makeSlackApi = Layer.succeed(
  SlackApiTag,
  new SlackApi(new WebClient(SLACK_TOKEN))
);

const makeSlackService = Layer.effect(
  SlackServiceTag,
  Effect.gen(function* (_) {
    const api = yield* _(SlackApiTag);

    const handleSlackResponse = <T>(response: { ok: boolean; error?: string } & T) => {
      if (!response.ok) {
        throw new SlackError(response.error || "Unknown Slack error");
      }
      return response;
    };

    const ensureChannelAccess = (channelId: string) =>
      Effect.gen(function* (_) {
        const authTest = yield* _(Effect.tryPromise({
          try: () => api.client.auth.test(),
          catch: (e: unknown) => new SlackError(`Auth test failed: ${String(e)}`)
        }));
        const botInfo = handleSlackResponse(authTest);
        
        if (!botInfo.user_id) {
          throw new SlackError('Bot user ID not found');
        }

        const channelInfo = yield* _(Effect.tryPromise({
          try: () => api.client.conversations.info({ channel: channelId }),
          catch: (e: unknown) => new SlackError(`Channel info failed: ${String(e)}`)
        }));
        const validChannelInfo = handleSlackResponse(channelInfo);

        const membersResult = yield* _(Effect.tryPromise({
          try: () => api.client.conversations.members({ channel: channelId }),
          catch: (e: unknown) => new SlackError(`Get members failed: ${String(e)}`)
        }));
        const members = handleSlackResponse(membersResult);

        if (members.members && !members.members.includes(botInfo.user_id)) {
          if (!validChannelInfo.channel) {
            throw new SlackError('Channel information not found');
          }

          const joinPromise = validChannelInfo.channel.is_private
            ? api.client.conversations.invite({
                channel: channelId,
                users: botInfo.user_id,
              })
            : api.client.conversations.join({
                channel: channelId,
              });

          const joinResult = yield* _(Effect.tryPromise({
            try: () => joinPromise,
            catch: (e: unknown) => new SlackError(`Join channel failed: ${String(e)}`)
          }));
          handleSlackResponse(joinResult);
          yield* _(Effect.sleep(Duration.millis(2000)));
        }
      });

    const service: SlackService = {
      sendMessage: (args: SendMessageArgs) =>
        Effect.gen(function* (_) {
          yield* _(ensureChannelAccess(args.channel));
          const result = yield* _(Effect.tryPromise({
            try: () =>
              api.client.chat.postMessage({
                channel: args.channel,
                text: args.text,
              }),
            catch: (e: unknown) => new SlackError(`Send message failed: ${String(e)}`)
          }));
          const response = handleSlackResponse(result);
          
          if (!response.ts || !response.channel) {
            throw new SlackError('Invalid response from Slack API');
          }

          return {
            status: "success",
            ts: response.ts,
            channel: response.channel,
          };
        }),

      listChannels: (args: ListChannelsArgs) =>
        Effect.gen(function* (_) {
          const result = yield* _(Effect.tryPromise({
            try: () =>
              api.client.conversations.list({
                limit: args.limit,
                exclude_archived: true,
                types: "public_channel,private_channel",
              }),
            catch: (e: unknown) => new SlackError(`List channels failed: ${String(e)}`)
          }));
          const response = handleSlackResponse(result);

          if (!response.channels) {
            return { channels: [] };
          }

          return {
            channels: response.channels.map(channel => ({
              id: channel.id ?? '',
              name: channel.name ?? '',
              is_private: channel.is_private || false,
              num_members: channel.num_members,
            })).filter(channel => channel.id && channel.name),
          };
        }),

      listUsers: (args: ListUsersArgs) =>
        Effect.gen(function* (_) {
          const result = yield* _(Effect.tryPromise({
            try: () =>
              api.client.users.list({
                limit: args.limit,
              }),
            catch: (e: unknown) => new SlackError(`List users failed: ${String(e)}`)
          }));
          const response = handleSlackResponse(result);

          if (!response.members) {
            return { users: [] };
          }

          return {
            users: response.members.map(user => ({
              id: user.id ?? '',
              name: user.name ?? '',
              real_name: user.real_name,
              is_bot: user.is_bot,
            })).filter(user => user.id && user.name),
          };
        }),

      getLatestMessage: (args: GetLatestMessageArgs) =>
        Effect.gen(function* (_) {
          yield* _(ensureChannelAccess(args.channel));
          const result = yield* _(Effect.tryPromise({
            try: () =>
              api.client.conversations.history({
                channel: args.channel,
                limit: 1,
              }),
            catch: (e: unknown) => new SlackError(`Get latest message failed: ${String(e)}`)
          }));
          const response = handleSlackResponse(result);
          
          if (!response.messages || response.messages.length === 0) {
            return { text: "No messages found in the channel" };
          }

          const message = response.messages[0];
          return {
            text: message.text,
            user: message.user,
            ts: message.ts,
            thread_ts: message.thread_ts,
          };
        }),
    };

    return service;
  })
);

// Server setup
const createServer = (slackService: SlackService): Server => {
  const server = new Server(
    {
      name: "slack-server",
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "send_message",
        description: "Send a message to a Slack channel",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel ID",
            },
            text: {
              type: "string",
              description: "Message text",
            },
          },
          required: ["channel", "text"],
        },
      },
      {
        name: "list_channels",
        description: "List Slack channels",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of channels to return",
              minimum: 1,
              maximum: 1000,
            },
          },
        },
      },
      {
        name: "list_users",
        description: "List Slack users",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of users to return",
              minimum: 1,
              maximum: 1000,
            },
          },
        },
      },
      {
        name: "get_latest_message",
        description: "Get the latest message from a channel",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel ID",
            },
          },
          required: ["channel"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handleResult = <T>(effect: Effect.Effect<never, SlackError, T>) =>
      Effect.runPromise(effect).then(
        result => ({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        }),
        error => ({
          content: [{ type: "text", text: `Slack API error: ${error.message}` }],
          isError: true,
        })
      );

    switch (request.params.name) {
      case "send_message": {
        const args = SendMessageSchema.parse(request.params.arguments);
        return handleResult(slackService.sendMessage(args));
      }
      case "list_channels": {
        const args = ListChannelsSchema.parse(request.params.arguments);
        return handleResult(slackService.listChannels(args));
      }
      case "list_users": {
        const args = ListUsersSchema.parse(request.params.arguments);
        return handleResult(slackService.listUsers(args));
      }
      case "get_latest_message": {
        const args = GetLatestMessageSchema.parse(request.params.arguments);
        return handleResult(slackService.getLatestMessage(args));
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  });

  server.onerror = (error) => console.error("[MCP Error]", error);
  return server;
};

// Main application
const program = Effect.gen(function* (_) {
  const slackService = yield* _(SlackServiceTag);
  const server = createServer(slackService);
  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  yield* _(Effect.tryPromise({
    try: () => server.connect(transport),
    catch: (e: unknown) => new SlackError(`Server connection failed: ${String(e)}`)
  }));
  console.error("Slack MCP server running on stdio");
  return Effect.unit;
});

const main = pipe(
  program,
  Effect.provide(makeSlackService),
  Effect.provide(makeSlackApi)
);

Effect.runPromise(main).catch(console.error);
