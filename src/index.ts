import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
	MCP_OBJECT: DurableObjectNamespace;
	WP_BASE_URL: string; // e.g. https://minicad.io  (no trailing slash)
	WP_OPS_KEY: string; // matches the MC_OPS_BRIDGE_KEY constant in wp-config.php
	MCP_AUTH_TOKEN: string; // bearer token Claude must send to reach this server
}

/* ── WordPress REST helper ──────────────────────────────────────────
 * Calls the MiniCAD Ops Bridge plugin's custom routes (minicad-ops/v1/...)
 * only — not WordPress's own wp/v2 API. Auth is a shared secret sent as
 * X-MC-Ops-Key, checked against the MC_OPS_BRIDGE_KEY constant defined in
 * wp-config.php (see minicad-ops-bridge.php). This deliberately avoids any
 * dependency on WordPress Application Passwords, since some hosts/security
 * plugins disable that feature.
 */
async function wp(
	env: Env,
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<{ ok: boolean; status: number; data: unknown }> {
	const base = env.WP_BASE_URL.replace(/\/+$/, "");
	const url = `${base}/wp-json/minicad-ops/v1${path}`;

	const res = await fetch(url, {
		method: init.method ?? "GET",
		headers: {
			"X-MC-Ops-Key": env.WP_OPS_KEY,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
	});

	let data: unknown = null;
	const text = await res.text();
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = text;
	}

	return { ok: res.ok, status: res.status, data };
}

function toolResult(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload as unknown as Record<string, unknown>,
	};
}

function toolError(status: number, data: unknown) {
	return {
		isError: true,
		content: [
			{
				type: "text" as const,
				text: `Request failed (HTTP ${status}): ${JSON.stringify(data)}`,
			},
		],
	};
}

const qs = (params: Record<string, string | number | undefined>) => {
	const usp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== "") usp.set(k, String(v));
	}
	const s = usp.toString();
	return s ? `?${s}` : "";
};

export class MiniCadOpsMCP extends McpAgent<Env> {
	server = new McpServer({ name: "minicad-ops-mcp", version: "1.0.0" });

	async init() {
		const env = this.env;

		/* ── Dashboard status ───────────────────────────────────────── */
		this.server.tool(
			"mc_status",
			"Snapshot of the MiniCAD site: count of new orders, unassigned open chats, and new leads.",
			{},
			async () => {
				const r = await wp(env, "/status");
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Orders ──────────────────────────────────────────────────── */
		this.server.tool(
			"mc_orders_list",
			"List orders with optional filters. Statuses: new, quoted, accepted, declined, in_progress, completed, cancelled.",
			{
				status: z.string().optional().describe("Filter by order status"),
				payment_status: z.string().optional().describe("unpaid | partially_paid | paid | overpaid | refunded"),
				search: z.string().optional().describe("Search name, email, or ref_id"),
				since: z.string().optional().describe("Only orders created on/after this date (YYYY-MM-DD)"),
				page: z.number().int().min(1).optional(),
				per_page: z.number().int().min(1).max(100).optional(),
			},
			async ({ status, payment_status, search, since, page, per_page }) => {
				const query = qs({ status, payment_status, search, since, page, per_page });
				const r = await wp(env, `/orders${query}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_order_get",
			"Get full detail for one order by its numeric row ID, including notes, payments, and activity timeline.",
			{ id: z.number().int().describe("Order row ID") },
			async ({ id }) => {
				const r = await wp(env, `/orders/${id}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_order_set_status",
			"Change an order's status. Mirrors the admin dashboard action exactly (logs the transition, adds a system note, and triggers the same email/WhatsApp notifications).",
			{
				id: z.number().int(),
				status: z.enum([
					"new",
					"quoted",
					"accepted",
					"declined",
					"in_progress",
					"completed",
					"cancelled",
				]),
			},
			async ({ id, status }) => {
				const r = await wp(env, `/orders/${id}/status`, {
					method: "POST",
					body: { status },
				});
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_order_add_note",
			"Add a manual note to an order's internal timeline (attributed to 'Claude (Ops MCP)').",
			{ id: z.number().int(), content: z.string().min(1) },
			async ({ id, content }) => {
				const r = await wp(env, `/orders/${id}/notes`, {
					method: "POST",
					body: { content },
				});
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_orders_activity",
			"Recent cross-order activity feed: status changes, payments, notes, and notification sends.",
			{ limit: z.number().int().min(1).max(100).optional() },
			async ({ limit }) => {
				const r = await wp(env, `/orders-activity${qs({ limit })}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Leads ───────────────────────────────────────────────────── */
		this.server.tool(
			"mc_leads_list",
			"List leads (pre-order contacts) with optional filters.",
			{
				status: z.string().optional(),
				search: z.string().optional(),
				page: z.number().int().min(1).optional(),
				per_page: z.number().int().min(1).max(100).optional(),
			},
			async ({ status, search, page, per_page }) => {
				const r = await wp(env, `/leads${qs({ status, search, page, per_page })}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Chat ────────────────────────────────────────────────────── */
		this.server.tool(
			"mc_chat_conversations_list",
			"List chat conversations with optional filters (e.g. status='open' and unassigned).",
			{
				status: z.string().optional(),
				search: z.string().optional(),
				page: z.number().int().min(1).optional(),
				per_page: z.number().int().min(1).max(100).optional(),
			},
			async ({ status, search, page, per_page }) => {
				const r = await wp(env, `/chat/conversations${qs({ status, search, page, per_page })}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_chat_messages_get",
			"Get messages in a chat conversation. Pass since_id to fetch only new messages after a given message ID.",
			{ conversation_id: z.number().int(), since_id: z.number().int().optional() },
			async ({ conversation_id, since_id }) => {
				const r = await wp(
					env,
					`/chat/conversations/${conversation_id}/messages${qs({ since_id })}`
				);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_chat_message_send",
			"Send a staff reply into a chat conversation (appears exactly like a reply sent from the admin chat inbox).",
			{ conversation_id: z.number().int(), body: z.string().min(1) },
			async ({ conversation_id, body }) => {
				const r = await wp(env, `/chat/conversations/${conversation_id}/messages`, {
					method: "POST",
					body: { body },
				});
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Whitelisted plugin/site options ────────────────────────────
		 * Only option keys listed in mc_ops_bridge_option_whitelist() on the
		 * WordPress side are reachable here — see minicad-ops-bridge.php.
		 */
		this.server.tool(
			"mc_options_get",
			"Read the current values of the whitelisted WordPress/plugin config options.",
			{},
			async () => {
				const r = await wp(env, `/options`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_options_set",
			"Update one or more whitelisted WordPress/plugin config options. Rejected if any key isn't on the site's whitelist.",
			{ options: z.record(z.any()).describe("Map of option_name -> new value") },
			async ({ options }) => {
				const r = await wp(env, `/options`, { method: "POST", body: options });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── WordPress posts — via the bridge plugin's own /posts routes,
		 * which call wp_insert_post()/wp_update_post() directly. This avoids
		 * any dependency on WordPress's wp/v2 REST auth (Application
		 * Passwords), consistent with every other tool in this server. ── */
		this.server.tool(
			"wp_posts_list",
			"List WordPress posts (any status) with optional search.",
			{
				status: z.enum(["publish", "future", "draft", "pending", "private", "any"]).optional(),
				search: z.string().optional(),
				page: z.number().int().min(1).optional(),
				per_page: z.number().int().min(1).max(100).optional(),
			},
			async ({ status, search, page, per_page }) => {
				const r = await wp(env, `/posts${qs({ status: status ?? "any", search, page, per_page })}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_post_get",
			"Get a single WordPress post by ID (any status), including full content.",
			{ id: z.number().int() },
			async ({ id }) => {
				const r = await wp(env, `/posts/${id}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_post_create",
			"Create a WordPress post — draft, publish immediately, or schedule for the future. To schedule, set status='future' and date to a datetime in the site's local timezone, e.g. '2026-07-20 09:00:00'.",
			{
				title: z.string().min(1),
				content: z.string().min(1).describe("Post body. HTML is allowed."),
				status: z.enum(["draft", "publish", "future", "pending"]).default("draft"),
				date: z.string().optional().describe("Required when status='future'. Site-local time, e.g. '2026-07-20 09:00:00'."),
				excerpt: z.string().optional(),
				slug: z.string().optional(),
				author_id: z.number().int().optional().describe("WP user ID to attribute the post to; defaults to the site's first Administrator"),
				categories: z.array(z.number().int()).optional().describe("Category term IDs"),
				tags: z.array(z.number().int()).optional().describe("Tag term IDs"),
			},
			async ({ title, content, status, date, excerpt, slug, author_id, categories, tags }) => {
				if (status === "future" && !date) {
					return toolError(400, { message: "date is required when status='future'" });
				}
				const r = await wp(env, `/posts`, {
					method: "POST",
					body: { title, content, status, date, excerpt, slug, author_id, categories, tags },
				});
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_post_update",
			"Update an existing WordPress post — change content, status, or reschedule (set status='future' + a new date).",
			{
				id: z.number().int(),
				title: z.string().optional(),
				content: z.string().optional(),
				status: z.enum(["draft", "publish", "future", "pending", "trash"]).optional(),
				date: z.string().optional(),
				excerpt: z.string().optional(),
				categories: z.array(z.number().int()).optional(),
				tags: z.array(z.number().int()).optional(),
			},
			async ({ id, ...fields }) => {
				const r = await wp(env, `/posts/${id}`, { method: "POST", body: fields });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_posts_schedule_batch",
			"Create multiple scheduled posts in one call — e.g. a week's worth of blog content. Each item needs its own date.",
			{
				posts: z
					.array(
						z.object({
							title: z.string().min(1),
							content: z.string().min(1),
							date: z.string().describe("Site-local time, e.g. '2026-07-20 09:00:00'"),
							excerpt: z.string().optional(),
							categories: z.array(z.number().int()).optional(),
							tags: z.array(z.number().int()).optional(),
						})
					)
					.min(1)
					.max(50),
			},
			async ({ posts }) => {
				const r = await wp(env, `/posts/batch-schedule`, { method: "POST", body: { posts } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const auth = request.headers.get("Authorization") ?? "";
		if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
			return new Response("Unauthorized", { status: 401 });
		}
		return MiniCadOpsMCP.serve("/mcp").fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
