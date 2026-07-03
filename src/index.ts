import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

/**
 * Environment bindings provided by Cloudflare.
 * You will set these in wrangler later:
 *  - SL_PIPELINE_URL: SnapLogic Triggered Task URL
 *  - SL_PIPELINE_TOKEN: SnapLogic Bearer token
 *  - MCP_API_KEY: API key clients must send to call /mcp
 */
type Env = {
  SL_PIPELINE_URL: string;
  SL_PIPELINE_TOKEN: string;
  MCP_API_KEY: string;
};

// Our MCP agent: one tool that forwards to SnapLogic
export class MyMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "snaplogic-agent",
    version: "1.0.0",
  });

  async init() {
    this.server.registerTool(
      "run_agent_tool",
      {
        description: "Primary interface to the SnapLogic agent. Always use this tool when the user asks about SnapLogic data, actions, or capabilities. " +
  "The agent will: (1) list its internal tools when asked about capabilities; (2) decide which internal tool to call (CRM lookups, web search, employee info, IT provisioning, training status, support tickets, etc.); (3) return the resulting data. " +
  "IMPORTANT: This tool returns the result of ONE internal tool call per invocation. " +
  "For compound requests that need data from multiple sources (e.g., 'give me a pre-meeting briefing with account info and support history', or 'show me Alice's onboarding status across IT, training, and her manager'), " +
  "call this tool MULTIPLE TIMES in sequence — once per data type needed. " +
  "Examples: " +
  "• 'Pre-meeting briefing with support' → call once for CRM/account info, then again for support tickets. " +
  "• 'Full onboarding status' → call once for employee info, again for IT provisioning, again for training. " +
  "• 'Show me my team and drill into anyone struggling' → call once for team summary, then chained calls per flagged employee. " +
  "Do not call SnapLogic's internal tools directly — always route through this tool with the user's natural-language request. " +
  "If you need different data, make a new call with a different, more targeted natural-language query.",
        inputSchema: {
          user_message: z
            .string() 
            .describe(
              "The user's full question or request, in natural language. Pass the user's intent through verbatim — the SnapLogic agent will interpret it and route to the appropriate internal tool. Examples: 'Look up CRM info for SnapLogic', 'What tools do you have available?', 'Search for recent news about Workday', 'Fetch the content of https://example.com'."
            ),
          conversation_history: z
            .array(
              z.object({
                content: z.string(),
                sl_role: z.string(),
              })
            )
            .describe(
              "Optional. Previous turns as [{content, sl_role}]. Pass this back on follow-up calls to continue a multi-step agentic conversation, e.g., after the agent has already invoked one tool and you need it to act on the result."
            )
            .optional(),
        },
      },
      // Tool implementation: call SnapLogic pipeline
      async ({ user_message, conversation_history }) => {
        const contents = Array.isArray(conversation_history)
          ? [...conversation_history]
          : [];
        contents.push({ content: user_message, sl_role: "USER" });

        const res = await fetch(this.env.SL_PIPELINE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.SL_PIPELINE_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ contents }),
        });

        if (!res.ok) {
          const text = await res.text();
          return {
            content: [
              {
                type: "text",
                text: `SnapLogic error ${res.status}: ${text}`,
              },
            ],
          };
        }

        const data = await res.json();
        const normalized =
          Array.isArray(data) && data.length === 1 ? data[0] : data;

        // Return the full SnapLogic response as JSON string
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(normalized),
            },
          ],
        };
      }
    );
  }
}

// HTTP handler: /health (no auth), /mcp (MCP with API-key auth)
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check, no auth
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // MCP endpoint – NO AUTH
    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};