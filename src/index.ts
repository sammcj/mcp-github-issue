#!/usr/bin/env node
import { config } from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface IssueDetails {
  title: string;
  body: string;
  url: string;
}

class GitHubIssueServer {
  private server: Server;
  private octokit: Octokit;

  private async initialize() {
    const packageJsonPath = resolve(__dirname, "../package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));

    this.server = new Server(
      {
        name: "github-issue-server",
        version: packageJson.version,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    const authToken = process.env.GITHUB_AUTH_TOKEN;
    this.octokit = new Octokit(authToken ? { auth: authToken } : {});

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  constructor() {
    // Properties will be initialized in initialize()
    this.server = {} as Server;
    this.octokit = {} as Octokit;
  }

  private parseGitHubUrl(url: string): {
    owner: string;
    repo: string;
    issue_number: number;
  } {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!match) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Invalid GitHub issue URL format. Expected: https://github.com/owner/repo/issues/number",
      );
    }
    return {
      owner: match[1],
      repo: match[2],
      issue_number: parseInt(match[3], 10),
    };
  }

  private async getIssueDetails(url: string): Promise<IssueDetails> {
    const { owner, repo, issue_number } = this.parseGitHubUrl(url);

    try {
      const response = await this.octokit.issues.get({
        owner,
        repo,
        issue_number,
      });

      return {
        title: response.data.title,
        body: response.data.body || "",
        url: response.data.html_url,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new McpError(
          ErrorCode.InternalError,
          `GitHub API error: ${error.message}`,
        );
      }
      throw error;
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_issue_task",
          description: "Fetch GitHub issue details to use as a task",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description:
                  "GitHub issue URL (https://github.com/owner/repo/issues/number)",
              },
            },
            required: ["url"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== "get_issue_task") {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`,
        );
      }

      const { url } = request.params.arguments as { url: string };
      if (!url) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "URL parameter is required",
        );
      }

      try {
        const issue = await this.getIssueDetails(url);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  task: {
                    title: issue.title,
                    description: issue.body,
                    source: issue.url,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Unexpected error: ${error}`,
        );
      }
    });
  }

  async run() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("GitHub Task MCP server running on stdio");
  }
}

const server = new GitHubIssueServer();
server.run().catch(console.error);
