// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Bitfocus Companion connection module for Breeze Overlay.
 *
 * Breeze accepts GET for every control verb so that header-less hardware can
 * drive it; this module uses POST and an `x-breeze-key` header instead, because
 * Companion can do both and a key in a query string ends up in Breeze's own
 * activity log and in any proxy log along the way.
 *
 * One connection points at one project. A show with two projects on one server
 * is two connections, which is also how the buttons want to be organised.
 */

import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'

import { BreezeApi, BreezeError, type ChannelState } from './api.js'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { BuildPresets } from './presets.js'
import { UpdateVariableDefinitions, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

/** A resolved trigger target. */
interface Target {
	project: string
	channel: string
}

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig
	secrets!: ModuleSecrets
	api!: BreezeApi

	/**
	 * Last known state per channel, keyed `project/channel`.
	 *
	 * Feedbacks are synchronous in spirit — they are called often and must not
	 * each fire an HTTP request — so they read this cache and the poll fills it.
	 */
	private states = new Map<string, ChannelState>()
	/** Channels any feedback has asked about, and so worth polling. */
	private watched = new Set<string>()
	private timer: NodeJS.Timeout | undefined
	private polling = false

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets ?? { apiKey: '' }
		this.applyConfig()

		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdateVariableDefinitions(this)

		this.setVariableValues({
			project: this.config.project ?? '',
			channel: '',
			playback_state: 'unknown',
			playback_step: '',
			playback_steps: '',
			sources_connected: '',
			panels_connected: '',
			server_version: '',
		})

		await this.connect()
	}

	async destroy(): Promise<void> {
		this.stopPolling()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets ?? { apiKey: '' }
		this.applyConfig()
		// The cache belongs to the old server; keeping it would colour buttons
		// from a machine this connection no longer points at.
		this.states.clear()
		await this.connect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	private applyConfig(): void {
		this.api = new BreezeApi({
			host: this.config.host ?? '127.0.0.1',
			port: this.config.port ?? 7331,
			apiKey: this.secrets.apiKey ?? '',
		})
	}

	/**
	 * Prove the server is reachable before claiming Ok.
	 *
	 * `/healthz` rather than a control call: it is a read, it needs no key, and
	 * it distinguishes "wrong address" from "right address, wrong key" — which
	 * are the two setup mistakes people actually make.
	 */
	private async connect(): Promise<void> {
		this.stopPolling()
		this.updateStatus(InstanceStatus.Connecting)

		try {
			const health = await this.api.health()
			this.setVariableValues({ server_version: health.version })
			await this.refreshPresets()
			this.updateStatus(InstanceStatus.Ok)
		} catch (error) {
			this.reportError('connect', error)
			// Still poll: the server may simply not be up yet, and a connection
			// that recovers on its own is the difference between a working show
			// and someone restarting Companion during a break.
		}

		this.startPolling()
	}

	/**
	 * Rebuild the preset list from what the server currently holds.
	 *
	 * Done at connect rather than on every poll: presets are a catalogue the
	 * user drags from, not live state, and rewriting them every second would
	 * churn the UI for no gain. Reconnecting — or hitting Save on the
	 * connection — is the natural moment to pick up a newly added scene.
	 */
	private async refreshPresets(): Promise<void> {
		const project = this.config.project?.trim()
		if (!project) {
			// Nothing to scope to. Empty rather than every project on the server:
			// a preset that addresses a project this connection is not configured
			// for would put the wrong graphic to air.
			this.setPresetDefinitions([], {})
			return
		}

		try {
			const all = await this.api.allChannels()
			const mine = all.find((p) => p.id === project)
			if (!mine) {
				this.log('warn', `Project "${project}" not found on the server — no presets generated`)
				this.setPresetDefinitions([], {})
				return
			}
			BuildPresets(this, mine.channels)
			this.log('debug', `Built presets for ${mine.channels.length} channels in ${mine.name}`)
		} catch (error) {
			// Presets are a convenience; failing to build them must not stop the
			// connection from working.
			this.log('warn', `Could not build presets: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	private startPolling(): void {
		const interval = Math.max(250, this.config.pollInterval ?? 1000)
		this.timer = setInterval(() => void this.poll(), interval)
		void this.poll()
	}

	private stopPolling(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
	}

	/** Poll immediately — called after an action, so the button does not lag a tick. */
	pollNow(): void {
		void this.poll()
	}

	/**
	 * Refresh every watched channel.
	 *
	 * Guarded against overlap: a server that has gone away leaves each request
	 * to time out, and without this the intervals would stack up requests faster
	 * than they drain.
	 */
	private async poll(): Promise<void> {
		if (this.polling) return
		const project = this.config.project?.trim()
		if (!project) return

		const channels = [...this.watched]
		if (channels.length === 0) return

		this.polling = true
		try {
			let reachable = false
			for (const channel of channels) {
				try {
					const state = await this.api.state(project, channel)
					this.states.set(`${project}/${channel}`, state)
					reachable = true
				} catch (error) {
					// A 404 is a wrong channel name, not a dead server — drop the
					// stale entry so a feedback stops claiming the graphic is up.
					this.states.delete(`${project}/${channel}`)
					if (error instanceof BreezeError && error.status !== 0) reachable = true
				}
			}

			if (reachable) this.updateStatus(InstanceStatus.Ok)
			else this.updateStatus(InstanceStatus.ConnectionFailure, `No response from ${this.api.base}`)

			this.publishDefaultVariables()
			this.checkFeedbacks('on_air', 'playback_state', 'source_connected')
		} finally {
			this.polling = false
		}
	}

	/** Variables track the connection's default channel — see `variables.ts`. */
	private publishDefaultVariables(): void {
		const target = this.resolveChannel('')
		if (!target) return

		const state = this.states.get(`${target.project}/${target.channel}`)
		this.setVariableValues({
			project: target.project,
			channel: target.channel,
			playback_state: state?.playback?.state ?? 'unknown',
			playback_step: state?.playback ? String(state.playback.step) : '',
			playback_steps: state?.playback ? String(state.playback.stepCount) : '',
			sources_connected: state ? String(state.renderers) : '',
			panels_connected: state ? String(state.controllers) : '',
		})
	}

	/**
	 * Work out what an action or feedback is aimed at.
	 *
	 * A blank channel means the connection's default. Accepts `project/channel`
	 * too, so one connection can reach a second project without reconfiguring —
	 * the address is the same shape the user already reads off the portal.
	 */
	resolveChannel(raw: string | undefined): Target | null {
		const value = (raw ?? '').trim()
		const fallbackProject = this.config.project?.trim() ?? ''

		if (value.includes('/')) {
			const at = value.indexOf('/')
			const project = value.slice(0, at).trim()
			const channel = value.slice(at + 1).trim()
			if (!project || !channel) return null
			this.watch(channel, project)
			return { project, channel }
		}

		if (!fallbackProject) return null
		const channel = value || this.defaultChannel
		if (!channel) return null
		this.watch(channel, fallbackProject)
		return { project: fallbackProject, channel }
	}

	/**
	 * The channel used when a button leaves the field blank.
	 *
	 * There is no config field for it on purpose: a default that silently drives
	 * a *different* graphic than the button says is worse than a button that
	 * does nothing and logs why. This is only set once something has named a
	 * channel explicitly, so the variables have something to report.
	 */
	private defaultChannel = ''

	private watch(channel: string, project: string): void {
		if (project !== (this.config.project?.trim() ?? '')) return
		if (!this.defaultChannel) this.defaultChannel = channel
		this.watched.add(channel)
	}

	/** Cached state for a feedback, or undefined before the first poll lands. */
	stateFor(rawChannel: string | undefined): ChannelState | undefined {
		const target = this.resolveChannel(rawChannel)
		if (!target) return undefined
		return this.states.get(`${target.project}/${target.channel}`)
	}

	/** One place that turns an error into a status and a log line. */
	reportError(what: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error)

		if (error instanceof BreezeError) {
			if (error.status === 401) {
				this.updateStatus(InstanceStatus.AuthenticationFailure, 'API key rejected')
				this.log('error', `${what}: ${message} — check the API key against BREEZE_API_KEY`)
				return
			}
			if (error.status === 404) {
				// Not a connection problem: the server answered. Saying otherwise
				// would send someone to check the network cable over a typo.
				this.log('error', `${what}: not found — check the project and channel keys`)
				return
			}
			if (error.status === 0) {
				this.updateStatus(InstanceStatus.ConnectionFailure, `Cannot reach ${this.api.base}`)
				this.log('error', `${what}: ${message}`)
				return
			}
		}

		this.updateStatus(InstanceStatus.UnknownError, message)
		this.log('error', `${what}: ${message}`)
	}
}
