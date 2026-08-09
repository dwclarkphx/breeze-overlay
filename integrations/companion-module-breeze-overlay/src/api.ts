// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The Breeze HTTP control API, as this module uses it.
 *
 * Everything here is a plain `fetch`. Breeze accepts GET for every verb —
 * deliberately, so header-less control surfaces can drive it — but this module
 * uses POST for the side-effecting ones and sends the key as a header. A key in
 * a query string ends up in the activity log and in any proxy log, and Companion
 * has no trouble setting a header.
 */

/** Shape of a verb response. `delivered` is the number of browser sources reached. */
export interface VerbResult {
	ok: boolean
	verb: string
	channel: string
	delivered: number
}

export interface PlaybackReport {
	state: string
	time: number
	step: number
	stepCount: number
}

export interface ChannelState {
	data: Record<string, unknown>
	playback: PlaybackReport | null
	/** Browser sources attached — vMix/OBS inputs and debug tabs. */
	renderers: number
	/** Control panels and editors. */
	controllers: number
	updatedAt: string
}

/** One addressable thing in a project: a scene, or a scene's independent element. */
export interface ChannelRef {
	channel: string
	ref: string
	/** What to call it on a button — the composition's or element's own name. */
	name: string
	sceneId: string | null
	layerId: string | null
}

export interface ProjectChannels {
	id: string
	name: string
	channels: ChannelRef[]
}

export interface ProjectSummary {
	id: string
	name: string
	compositions: Array<{ id: string; name: string }>
}

export class BreezeError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = 'BreezeError'
	}
}

export interface BreezeConfig {
	host: string
	port: number
	apiKey: string
}

export class BreezeApi {
	constructor(private readonly config: BreezeConfig) {}

	get base(): string {
		// No scheme in the config field: Breeze is served over plain HTTP on a
		// LAN, and offering a choice invites someone to pick https on a server
		// that has no certificate and then debug the wrong thing.
		return `http://${this.config.host}:${this.config.port}`
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const headers: Record<string, string> = { accept: 'application/json' }
		if (this.config.apiKey) headers['x-breeze-key'] = this.config.apiKey
		if (init?.body) headers['content-type'] = 'application/json'

		let response: Response
		try {
			response = await fetch(`${this.base}${path}`, {
				...init,
				headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
				// A control surface that hangs is worse than one that reports a
				// failure: the operator presses again, and again.
				signal: AbortSignal.timeout(5000),
			})
		} catch (error) {
			throw new BreezeError(error instanceof Error ? error.message : String(error), 0)
		}

		if (!response.ok) {
			let detail = response.statusText
			try {
				const body = (await response.json()) as { error?: string }
				if (body.error) detail = body.error
			} catch {
				// Non-JSON error body; the status line is all we have.
			}
			throw new BreezeError(detail, response.status)
		}

		return (await response.json()) as T
	}

	/** `play` | `next` | `stop` | `clear` | `clear-all`. */
	async verb(project: string, channel: string, verb: string): Promise<VerbResult> {
		return this.request<VerbResult>(
			`/api/control/${encodeURIComponent(project)}/${encodeURIComponent(channel)}/${verb}`,
			{ method: 'POST' },
		)
	}

	/**
	 * Push dynamic field values.
	 *
	 * POSTed as a JSON body rather than a query string, so a value containing an
	 * ampersand or a newline arrives intact — a lower third carrying a quote from
	 * a press release will eventually contain both.
	 */
	async update(
		project: string,
		channel: string,
		fields: Record<string, string>,
	): Promise<VerbResult> {
		return this.request<VerbResult>(
			`/api/control/${encodeURIComponent(project)}/${encodeURIComponent(channel)}/update`,
			{ method: 'POST', body: JSON.stringify(fields) },
		)
	}

	/** Read-only, safe to poll. */
	async state(project: string, channel: string): Promise<ChannelState> {
		const body = await this.request<{ channel: string; state: ChannelState }>(
			`/api/control/${encodeURIComponent(project)}/${encodeURIComponent(channel)}/state`,
		)
		return body.state
	}

	async projects(): Promise<ProjectSummary[]> {
		const body = await this.request<{ projects: ProjectSummary[] }>('/api/projects')
		return body.projects
	}

	/**
	 * Every address a project answers to, including scene elements.
	 *
	 * The authoritative list — it is the same index the server resolves a trigger
	 * against, so anything absent from it will 404.
	 */
	async channels(project: string): Promise<ChannelRef[]> {
		const body = await this.request<{ channels: ChannelRef[] }>(
			`/api/projects/${encodeURIComponent(project)}/channels`,
		)
		return body.channels
	}

	/**
	 * Every channel on the server, in one request.
	 *
	 * What the presets are built from. One call rather than `/api/projects`
	 * followed by a `/channels` per project — see the route.
	 */
	async allChannels(): Promise<ProjectChannels[]> {
		const body = await this.request<{ projects: ProjectChannels[] }>('/api/channels')
		return body.projects
	}

	/** Server-wide health, used to prove the connection at startup. */
	async health(): Promise<{ ok: boolean; version: string }> {
		return this.request<{ ok: boolean; version: string }>('/healthz')
	}
}
