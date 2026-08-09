// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { InstanceStatus } from '@companion-module/base'
import type ModuleInstance from './main.js'

export type ActionsSchema = {
	play: { options: { channel: string } }
	next: { options: { channel: string } }
	stop: { options: { channel: string } }
	clear: { options: { channel: string } }
	clear_all: { options: { channel: string } }
	update: { options: { channel: string; fields: string } }
}

/**
 * Parse the field editor's `name=value` lines.
 *
 * One pair per line rather than a query string: a lower third carries prose,
 * and prose contains ampersands. Split on the *first* `=` only, so a value may
 * contain one — `title=Head of R&D = Research` is a real thing someone types.
 */
export function parseFields(raw: string): Record<string, string> {
	const fields: Record<string, string> = {}
	for (const line of raw.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '') continue
		const eq = trimmed.indexOf('=')
		if (eq <= 0) continue
		/*
		 * The value is trimmed too. `name = Jane` is what people type, and a
		 * leading space on a lower third is visible on air — a stray one is far
		 * more likely than a deliberate one.
		 */
		fields[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
	}
	return fields
}

export function UpdateActions(self: ModuleInstance): void {
	/**
	 * Run a verb and report honestly.
	 *
	 * `delivered: 0` is the case worth surfacing: the call succeeded and nothing
	 * was listening, so nothing happened on screen. Companion would otherwise
	 * show a perfectly green button for a graphic that never appeared, which is
	 * the exact confusion this module should be removing.
	 */
	const run = async (channel: string, verb: string): Promise<void> => {
		const target = self.resolveChannel(channel)
		if (!target) {
			self.log('warn', `No channel given for ${verb}, and no default set in the connection config`)
			return
		}

		try {
			const result = await self.api.verb(target.project, target.channel, verb)
			if (result.delivered === 0) {
				self.log(
					'warn',
					`${verb} ${target.project}/${target.channel} reached no browser sources — is the output open in OBS or vMix?`,
				)
			}
			self.updateStatus(InstanceStatus.Ok)
			// The graphic has just changed; do not wait up to a poll interval to
			// say so on the button.
			self.pollNow()
		} catch (error) {
			self.reportError(`${verb} ${target.project}/${target.channel}`, error)
		}
	}

	/*
	 * `useVariables: true` is all that is needed to support `$(internal:…)` in
	 * these fields. Companion resolves them before the callback runs, so the
	 * option arrives as a plain string — module-base v2 dropped the
	 * `context.parseVariablesInString` that v1 modules had to call by hand.
	 */
	const channelOption = {
		id: 'channel' as const,
		type: 'textinput' as const,
		label: 'Scene or element channel (blank = connection default)',
		default: '',
		useVariables: true,
	}

	self.setActionDefinitions({
		play: {
			name: 'PLAY — roll in, or advance to the next hold',
			options: [channelOption],
			callback: async (event) => run(event.options.channel, 'play'),
		},
		next: {
			name: 'NEXT — advance to the next hold',
			options: [channelOption],
			callback: async (event) => run(event.options.channel, 'next'),
		},
		stop: {
			name: 'STOP — run the outro',
			options: [channelOption],
			callback: async (event) => run(event.options.channel, 'stop'),
		},
		clear: {
			name: 'CLEAR — hard reset, nothing on screen',
			options: [channelOption],
			callback: async (event) => run(event.options.channel, 'clear'),
		},
		clear_all: {
			name: 'CLEAR ALL — every element of a scene down at once',
			options: [channelOption],
			callback: async (event) => run(event.options.channel, 'clear-all'),
		},
		update: {
			name: 'Update fields on air',
			options: [
				channelOption,
				{
					id: 'fields',
					type: 'textinput',
					label: 'Fields, one name=value per line',
					default: 'name=Jane Doe\ntitle=Reporter',
					useVariables: true,
					multiline: true,
				},
			],
			callback: async (event) => {
				const target = self.resolveChannel(event.options.channel)
				if (!target) {
					self.log('warn', 'No channel given for update, and no default set')
					return
				}

				const fields = parseFields(event.options.fields)
				if (Object.keys(fields).length === 0) {
					self.log('warn', 'Update had no name=value lines, so nothing was sent')
					return
				}

				try {
					const result = await self.api.update(target.project, target.channel, fields)
					if (result.delivered === 0) {
						self.log(
							'warn',
							`Update to ${target.project}/${target.channel} reached no browser sources`,
						)
					}
					self.updateStatus(InstanceStatus.Ok)
					self.pollNow()
				} catch (error) {
					self.reportError(`update ${target.project}/${target.channel}`, error)
				}
			},
		},
	})
}
