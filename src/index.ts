import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
	MCP_OBJECT: DurableObjectNamespace;
	WP_BASE_URL: string; // e.g. https://minicad.io  (no trailing slash)
	WP_OPS_KEY: string; // matches the MC_OPS_BRIDGE_KEY constant in wp-config.php
	MCP_PATH_SECRET: string; // long random string — the ONLY thing gating access to this server.
	// Claude's custom-connector flow doesn't support user-pasted bearer tokens
	// yet (only OAuth or no-auth), so instead of an Authorization header this
	// server folds its secret into the URL path itself: the real MCP endpoint
	// is /mcp/<MCP_PATH_SECRET>, not /mcp. Anything else gets a plain 404 —
	// never a 401 — so Claude never attempts (and fails) an OAuth handshake.
	// Treat this value exactly like a password: whoever has the full URL has
	// complete read/write access to orders, contacts, leads, invoices, chat,
	// posts, and — for the WP-management tools below — the site's plugins,
	// updates, and a read-only DB query.
}

const WP_FETCH_TIMEOUT_MS = 20_000;

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

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), WP_FETCH_TIMEOUT_MS);

	let res: Response;
	try {
		res = await fetch(url, {
			method: init.method ?? "GET",
			headers: {
				"X-MC-Ops-Key": env.WP_OPS_KEY,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		const message =
			err instanceof Error && err.name === "AbortError"
				? `Request to WordPress timed out after ${WP_FETCH_TIMEOUT_MS / 1000}s (${path}).`
				: `Could not reach WordPress at ${path}: ${err instanceof Error ? err.message : String(err)}`;
		return { ok: false, status: 0, data: { message } };
	} finally {
		clearTimeout(timeout);
	}

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
	// structuredContent must be a JSON object, not a bare array — guard here
	// in addition to the WordPress side returning objects, so a future
	// upstream regression degrades to a wrapped array instead of an MCP
	// validation error.
	const structured = Array.isArray(payload) ? { items: payload } : payload;
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		structuredContent: structured as unknown as Record<string, unknown>,
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
	server = new McpServer({ name: "minicad-ops-mcp", version: "1.2.0" });

	async init() {
		const env = this.env;

		/* ── Dashboard status ───────────────────────────────────────── */
		this.server.tool(
			"mc_status",
			"Snapshot of the MiniCAD site: count of new orders, unassigned open chats, new leads, and total contacts.",
			{},
			{ readOnlyHint: true, openWorldHint: true },
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
			{ readOnlyHint: true, openWorldHint: true },
			async ({ status, payment_status, search, since, page, per_page }) => {
				const query = qs({ status, payment_status, search, since, page, per_page });
				const r = await wp(env, `/orders${query}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_order_get",
			"Get full detail for one order by its numeric row ID, including notes, payments, invoices, and activity timeline.",
			{ id: z.number().int().describe("Order row ID") },
			{ readOnlyHint: true, openWorldHint: true },
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
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
			{ readOnlyHint: true, openWorldHint: true },
			async ({ limit }) => {
				const r = await wp(env, `/orders-activity${qs({ limit })}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Invoices ────────────────────────────────────────────────── */
		this.server.tool(
			"mc_invoices_list_for_order",
			"List every invoice raised against a given order.",
			{ order_id: z.number().int() },
			{ readOnlyHint: true, openWorldHint: true },
			async ({ order_id }) => {
				const r = await wp(env, `/orders/${order_id}/invoices`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_invoice_create",
			"Create a new invoice against an order.",
			{
				order_id: z.number().int(),
				amount: z.number().positive(),
				gateway: z.string().optional().describe("Payment gateway this invoice will be paid through, e.g. 'stripe' or 'wise'"),
				description: z.string().optional(),
				line_items: z
					.array(z.object({ label: z.string(), amount: z.number() }))
					.optional(),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			async ({ order_id, amount, gateway, description, line_items }) => {
				const r = await wp(env, `/orders/${order_id}/invoices`, {
					method: "POST",
					body: { amount, gateway, description, line_items },
				});
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_invoice_get",
			"Get a single invoice by its row ID.",
			{ id: z.number().int() },
			{ readOnlyHint: true, openWorldHint: true },
			async ({ id }) => {
				const r = await wp(env, `/invoices/${id}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_invoice_update",
			"Update an invoice's status, description, or gateway.",
			{
				id: z.number().int(),
				status: z.string().optional(),
				description: z.string().optional(),
				gateway: z.string().optional(),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			async ({ id, ...fields }) => {
				const r = await wp(env, `/invoices/${id}`, { method: "POST", body: fields });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_invoice_mark_paid",
			"Mark an invoice as paid — mirrors what happens when a payment gateway webhook confirms payment (same code path, so any paid-invoice notifications still fire).",
			{
				id: z.number().int(),
				amount: z.number().optional().describe("Amount actually received; defaults to the invoice's full amount"),
				gateway_payment_id: z.string().optional(),
				method: z.string().optional(),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			async ({ id, amount, gateway_payment_id, method }) => {
				const r = await wp(env, `/invoices/${id}/mark-paid`, {
					method: "POST",
					body: { amount, gateway_payment_id, method },
				});
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Contacts ────────────────────────────────────────────────── */
		this.server.tool(
			"mc_contacts_list",
			"List/search the contacts CRM with optional filters.",
			{
				search: z.string().optional().describe("Search name/email/phone"),
				country: z.string().optional(),
				lead_status: z.string().optional(),
				tag: z.string().optional(),
				source: z.string().optional(),
				page: z.number().int().min(1).optional(),
				per_page: z.number().int().min(1).max(100).optional(),
			},
			{ readOnlyHint: true, openWorldHint: true },
			async (args) => {
				const r = await wp(env, `/contacts${qs(args)}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_contact_get",
			"Get full detail for a contact, including notes and linked orders/leads/conversations.",
			{ id: z.number().int() },
			{ readOnlyHint: true, openWorldHint: true },
			async ({ id }) => {
				const r = await wp(env, `/contacts/${id}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_contact_update",
			"Update a contact's name, country, lead_status, marketing consent, or tags.",
			{
				id: z.number().int(),
				name: z.string().optional(),
				country: z.string().optional(),
				lead_status: z.string().optional(),
				marketing_consent: z.boolean().optional(),
				tags: z.array(z.string()).optional(),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			async ({ id, ...fields }) => {
				const r = await wp(env, `/contacts/${id}`, { method: "POST", body: fields });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_contact_add_note",
			"Add a note to a contact's timeline (attributed to 'Claude (Ops MCP)').",
			{ id: z.number().int(), body: z.string().min(1) },
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			async ({ id, body }) => {
				const r = await wp(env, `/contacts/${id}/notes`, { method: "POST", body: { body } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_contacts_stats",
			"Dashboard-style aggregate stats for the contacts CRM (totals by country, lead status, etc.).",
			{},
			{ readOnlyHint: true, openWorldHint: true },
			async () => {
				const r = await wp(env, `/contacts-stats`);
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
			{ readOnlyHint: true, openWorldHint: true },
			async ({ status, search, page, per_page }) => {
				const r = await wp(env, `/leads${qs({ status, search, page, per_page })}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_lead_get",
			"Get a single lead by its row ID.",
			{ id: z.number().int() },
			{ readOnlyHint: true, openWorldHint: true },
			async ({ id }) => {
				const r = await wp(env, `/leads/${id}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_lead_update",
			"Update a lead's status or contact details.",
			{
				id: z.number().int(),
				status: z.string().optional(),
				name: z.string().optional(),
				email: z.string().optional(),
				phone: z.string().optional(),
				notes: z.string().optional(),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			async ({ id, ...fields }) => {
				const r = await wp(env, `/leads/${id}`, { method: "POST", body: fields });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_leads_delete",
			"Permanently delete one or more leads by ID. This cannot be undone — confirm with the user before calling this for anything other than obvious spam/test entries.",
			{ ids: z.array(z.number().int()).min(1) },
			{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
			async ({ ids }) => {
				const r = await wp(env, `/leads/delete`, { method: "POST", body: { ids } });
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
			{ readOnlyHint: true, openWorldHint: true },
			async ({ status, search, page, per_page }) => {
				const r = await wp(env, `/chat/conversations${qs({ status, search, page, per_page })}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_chat_conversation_get",
			"Get a single chat conversation, including its full message history.",
			{ id: z.number().int() },
			{ readOnlyHint: true, openWorldHint: true },
			async ({ id }) => {
				const r = await wp(env, `/chat/conversations/${id}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_chat_conversation_update",
			"Update a chat conversation's status (e.g. open/closed) or reassign it to a different agent user ID.",
			{
				id: z.number().int(),
				status: z.string().optional(),
				assigned_agent_id: z.number().int().optional(),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			async ({ id, ...fields }) => {
				const r = await wp(env, `/chat/conversations/${id}`, { method: "POST", body: fields });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_chat_messages_get",
			"Get messages in a chat conversation. Pass since_id to fetch only new messages after a given message ID.",
			{ conversation_id: z.number().int(), since_id: z.number().int().optional() },
			{ readOnlyHint: true, openWorldHint: true },
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
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
			{ readOnlyHint: true, openWorldHint: true },
			async () => {
				const r = await wp(env, `/options`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_options_set",
			"Update one or more whitelisted WordPress/plugin config options. Rejected if any key isn't on the site's whitelist.",
			{ options: z.record(z.any()).describe("Map of option_name -> new value") },
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			async ({ options }) => {
				const r = await wp(env, `/options`, { method: "POST", body: options });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Pricing — re-price one package/extra by slug without touching
		 * the rest of the catalog. Look up slugs and current prices first
		 * with mc_options_get (keys: mc_packages, mc_extras). ── */
		this.server.tool(
			"mc_package_reprice",
			"Change the price (and optionally the delivery-timeline prices) of one package, found by its slug — every other package and field is left untouched. Get current slugs/prices from mc_options_get's mc_packages value first.",
			{
				slug: z.string().min(1).describe("Package slug, e.g. 'basic' (see mc_packages via mc_options_get)"),
				price: z.number().nonnegative().optional().describe("New base price"),
				timelines: z
					.array(z.object({ label: z.string(), free: z.boolean().optional(), price: z.number().nonnegative() }))
					.optional()
					.describe("Replaces the package's delivery-timeline price tiers, e.g. [{ label: '5 days', free: true, price: 0 }, { label: '2 days', price: 20 }]"),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			async ({ slug, price, timelines }) => {
				if (price === undefined && timelines === undefined) {
					return toolError(400, { message: "Provide price and/or timelines." });
				}
				const r = await wp(env, `/packages/reprice`, { method: "POST", body: { slug, price, timelines } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_extra_reprice",
			"Change the price of one extra service, found by its slug — every other extra is left untouched. Get current slugs/prices from mc_options_get's mc_extras value first.",
			{
				slug: z.string().min(1).describe("Extra slug, e.g. 'priority' (see mc_extras via mc_options_get)"),
				price: z.number().nonnegative(),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			async ({ slug, price }) => {
				const r = await wp(env, `/extras/reprice`, { method: "POST", body: { slug, price } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Coupons — create/update/delete by code, e.g. for a seasonal
		 * promotion. Only the matching coupon row is touched; the rest of
		 * the coupon list is left untouched. ── */
		this.server.tool(
			"mc_coupon_create",
			"Create a new discount coupon (e.g. for a seasonal promotion or event). Fails if the code already exists — use mc_coupon_update instead.",
			{
				code: z.string().min(1).describe("Coupon code, e.g. 'SUMMER25' (case-insensitive, stored uppercase)"),
				type: z.enum(["percent", "fixed"]).default("percent"),
				amount: z.number().positive().describe("Discount amount — a percentage (0-100) if type='percent', or a flat currency amount if type='fixed'"),
				name: z.string().optional().describe("Display name; defaults to the code"),
				active: z.boolean().optional().describe("Defaults to true"),
				auto_apply: z.boolean().optional().describe("Apply automatically at checkout without the customer entering the code"),
				expires: z.string().optional().describe("Expiry date, YYYY-MM-DD. Leave unset for no expiry."),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			async ({ code, type, amount, name, active, auto_apply, expires }) => {
				const r = await wp(env, `/coupons`, {
					method: "POST",
					body: { code, type, amount, name, active, auto_apply, expires },
				});
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_coupon_update",
			"Update an existing coupon's amount, type, active state, auto_apply, expiry, or display name, found by its code.",
			{
				code: z.string().min(1),
				type: z.enum(["percent", "fixed"]).optional(),
				amount: z.number().positive().optional(),
				name: z.string().optional(),
				active: z.boolean().optional().describe("Set to false to deactivate a coupon, e.g. once a promotion ends"),
				auto_apply: z.boolean().optional(),
				expires: z.string().optional().describe("Expiry date, YYYY-MM-DD"),
			},
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			async ({ code, ...fields }) => {
				const r = await wp(env, `/coupons/${encodeURIComponent(code)}`, { method: "POST", body: fields });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"mc_coupon_delete",
			"Permanently remove a coupon by code, e.g. once a seasonal promotion has ended.",
			{ code: z.string().min(1) },
			{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
			async ({ code }) => {
				const r = await wp(env, `/coupons/${encodeURIComponent(code)}/delete`, { method: "POST" });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── FAQs — mc_faqs has no natural unique key (question text can
		 * repeat), so update/delete address a row by its 0-based position.
		 * Get the current list/order from mc_options_get's mc_faqs value
		 * first. ── */
		this.server.tool(
			"mc_faq_manage",
			"Create, update, or delete a FAQ entry. For 'update'/'delete', pass the 0-based index of the FAQ from mc_options_get's mc_faqs value — order can shift if the list changes, so re-check the index if unsure.",
			{
				action: z.enum(["create", "update", "delete"]),
				index: z.number().int().min(0).optional().describe("Required for update/delete — 0-based position in the current mc_faqs list"),
				category: z.string().optional().describe("e.g. 'General', 'Pricing', 'Delivery'"),
				question: z.string().optional().describe("Required for create"),
				answer: z.string().optional().describe("Required for create. HTML is allowed."),
				active: z.boolean().optional(),
			},
			{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
			async ({ action, index, category, question, answer, active }) => {
				if (action === "create") {
					if (!question || !answer) {
						return toolError(400, { message: "question and answer are required to create a FAQ." });
					}
					const r = await wp(env, `/faqs`, { method: "POST", body: { category, question, answer, active } });
					return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
				}
				if (index === undefined) {
					return toolError(400, { message: "index is required for update/delete — get it from mc_options_get's mc_faqs value." });
				}
				if (action === "delete") {
					const r = await wp(env, `/faqs/${index}/delete`, { method: "POST" });
					return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
				}
				const r = await wp(env, `/faqs/${index}`, { method: "POST", body: { category, question, answer, active } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Brands — matched by name (case-insensitive), same pattern as
		 * coupons' code. ── */
		this.server.tool(
			"mc_brand_manage",
			"Create, update, or delete a client/partner brand logo entry. 'name' identifies the brand (case-insensitive) for update/delete; use new_name to rename one.",
			{
				action: z.enum(["create", "update", "delete"]),
				name: z.string().min(1).describe("Brand name — required always: the new brand's name for create, or the existing brand to match for update/delete"),
				logo: z.string().optional().describe("Logo image URL"),
				url: z.string().optional().describe("Brand's website URL"),
				new_name: z.string().optional().describe("Update only: rename the brand to this"),
			},
			{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
			async ({ action, name, logo, url, new_name }) => {
				if (action === "create") {
					const r = await wp(env, `/brands`, { method: "POST", body: { name, logo, url } });
					return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
				}
				if (action === "delete") {
					const r = await wp(env, `/brands/${encodeURIComponent(name)}/delete`, { method: "POST" });
					return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
				}
				const body: Record<string, unknown> = {};
				if (new_name !== undefined) body.name = new_name;
				if (logo !== undefined) body.logo = logo;
				if (url !== undefined) body.url = url;
				const r = await wp(env, `/brands/${encodeURIComponent(name)}`, { method: "POST", body });
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
			{ readOnlyHint: true, openWorldHint: true },
			async ({ status, search, page, per_page }) => {
				const r = await wp(env, `/posts${qs({ status: status ?? "any", search, page, per_page })}`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_post_get",
			"Get a single WordPress post by ID (any status), including full content.",
			{ id: z.number().int() },
			{ readOnlyHint: true, openWorldHint: true },
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
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
			{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			async ({ posts }) => {
				const r = await wp(env, `/posts/batch-schedule`, { method: "POST", body: { posts } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── WordPress plugin management ────────────────────────────────
		 * Activate/deactivate use a "confirm: true" speed bump since a bad
		 * activation can white-screen the site. Deactivating a plugin is the
		 * usual first fix if that happens.
		 */
		this.server.tool(
			"wp_plugins_list",
			"List every installed plugin: name, version, whether it's active, and whether an update is available.",
			{},
			{ readOnlyHint: true, openWorldHint: true },
			async () => {
				const r = await wp(env, `/wp/plugins`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_plugin_activate",
			"Activate an installed plugin by its file path (e.g. 'akismet/akismet.php', from wp_plugins_list). Requires confirm:true — an incompatible plugin can break the site.",
			{ file: z.string().min(1), confirm: z.literal(true) },
			{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
			async ({ file, confirm }) => {
				const r = await wp(env, `/wp/plugins/activate`, { method: "POST", body: { file, confirm } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_plugin_deactivate",
			"Deactivate a plugin by its file path. This is the usual first fix if activating/updating a plugin broke the site. Requires confirm:true.",
			{ file: z.string().min(1), confirm: z.literal(true) },
			{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
			async ({ file, confirm }) => {
				const r = await wp(env, `/wp/plugins/deactivate`, { method: "POST", body: { file, confirm } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── WordPress core / plugin / theme updates ─────────────────────
		 * wp_updates_check is safe and read-only. The three apply-tools are
		 * the riskiest actions this server can take — each requires
		 * confirm:true, and wp_core_update in particular should only be run
		 * right after confirming a recent backup exists: it changes WordPress
		 * core itself and is the hardest of the three to walk back if
		 * something goes wrong on this specific host.
		 */
		this.server.tool(
			"wp_updates_check",
			"Check for available WordPress core, plugin, and theme updates. Read-only — safe to call any time.",
			{},
			{ readOnlyHint: true, openWorldHint: true },
			async () => {
				const r = await wp(env, `/wp/updates`);
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_plugin_update",
			"Update a single plugin to its latest version. Requires confirm:true. Not trivially reversible on shared hosting (no automatic rollback) — worth checking the plugin's changelog for breaking changes first.",
			{ file: z.string().min(1), confirm: z.literal(true) },
			{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
			async ({ file, confirm }) => {
				const r = await wp(env, `/wp/updates/plugin`, { method: "POST", body: { file, confirm } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_theme_update",
			"Update a theme to its latest version. Requires confirm:true. Not trivially reversible on shared hosting — check for child-theme/override conflicts first.",
			{ stylesheet: z.string().min(1).describe("Theme stylesheet slug, e.g. 'astra'"), confirm: z.literal(true) },
			{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
			async ({ stylesheet, confirm }) => {
				const r = await wp(env, `/wp/updates/theme`, { method: "POST", body: { stylesheet, confirm } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		this.server.tool(
			"wp_core_update",
			"Update WordPress core to the latest available version. HIGH RISK — this is the hardest of the update tools to reverse on this host. Requires confirm:true. Always confirm a recent site backup exists before calling this, and prefer running it manually from wp-admin unless there's a specific reason to do it here.",
			{ confirm: z.literal(true) },
			{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
			async ({ confirm }) => {
				const r = await wp(env, `/wp/updates/core`, { method: "POST", body: { confirm } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);

		/* ── Read-only database query ────────────────────────────────────
		 * SELECT / SHOW / DESCRIBE / EXPLAIN only — enforced on the
		 * WordPress side (minicad-ops-bridge.php), not just here. wp_users,
		 * wp_usermeta, and wp_options are additionally blocked there (see
		 * that file) so this ad-hoc tool can't be used to read password
		 * hashes or option values excluded from mc_options_get/set. Use this
		 * for ad-hoc reporting questions that the structured tools above
		 * don't cover directly. It deliberately cannot write — every write
		 * in this server goes through the structured routes above so the
		 * site's normal hooks/notifications/logging still fire.
		 */
		this.server.tool(
			"wp_db_query",
			"Run a read-only SQL query against the WordPress database (SELECT / SHOW / DESCRIBE / EXPLAIN only — writes are rejected). Cannot query wp_users, wp_usermeta, or wp_options directly — use mc_options_get/mc_options_set for whitelisted settings instead. Useful for ad-hoc reporting that the structured tools don't cover. Table names use the site's actual prefix (commonly 'wp_') — check with `SHOW TABLES` if unsure. A LIMIT is added automatically if you don't include one.",
			{
				sql: z.string().min(1),
				limit: z.number().int().min(1).max(500).optional().describe("Max rows to return if the query has no explicit LIMIT (default 100, max 500)"),
			},
			{ readOnlyHint: true, openWorldHint: true },
			async ({ sql, limit }) => {
				const r = await wp(env, `/db/query`, { method: "POST", body: { sql, limit } });
				return r.ok ? toolResult(r.data) : toolError(r.status, r.data);
			}
		);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const securedPath = `/mcp/${env.MCP_PATH_SECRET}`;

		// Anything that isn't exactly our secret path gets a plain 404 — never
		// a 401. A 401 would make Claude think this server requires OAuth and
		// try (and fail) to auto-discover/register an OAuth client, which is
		// exactly the error this replaced. A 404 just looks like "no such
		// route," so Claude treats a request to the correct secret URL as a
		// normal, fully-open (no-auth) MCP connection.
		if (!url.pathname.startsWith(securedPath)) {
			return new Response("Not found", { status: 404 });
		}

		// Rewrite the path so the MCP handler (bound to "/mcp") sees a normal
		// "/mcp" request once the secret prefix has already been checked.
		// `new Request(newUrl, originalRequest)` clones method/headers/body
		// from the original request onto the new URL.
		const innerUrl = new URL(request.url);
		innerUrl.pathname = "/mcp" + url.pathname.slice(securedPath.length);
		const innerRequest = new Request(innerUrl.toString(), request);

		return MiniCadOpsMCP.serve("/mcp").fetch(innerRequest, env, ctx);
	},
} satisfies ExportedHandler<Env>;
