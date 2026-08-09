// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Ready-made buttons, one set per addressable graphic.
 *
 * Built from `GET /api/channels`, which lists every scene and scene element on
 * the server in a single request — presets need to enumerate everything, and
 * doing that per project would be an N+1 against a server that is also feeding
 * graphics to air.
 *
 * Only the channels belonging to this connection's project get presets. A
 * connection is configured for one project, and offering buttons that silently
 * address a different one is how a graphic goes to air in the wrong show.
 */

import { combineRgb } from '@companion-module/base'
import type { CompanionPresetDefinitions, CompanionPresetSection } from '@companion-module/base'

import type { ChannelRef } from './api.js'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const RED = combineRgb(200, 0, 0)
const GREEN = combineRgb(0, 120, 40)
const AMBER = combineRgb(150, 90, 0)

/**
 * Companion preset ids must be stable across restarts, or a button a user has
 * already placed loses its link to the preset it came from. The channel name is
 * the stable thing here — it is the address, and Breeze does not let it be
 * renamed.
 */
const idFor = (channel: string, verb: string) => `${channel}__${verb}`

/**
 * Button text: the graphic's name, a real newline, then the verb.
 *
 * A literal `\n` two-character sequence would depend on Companion parsing
 * escapes in button text, which its types do not promise. An actual newline
 * cannot be misread. Wrapping is left to `size: 'auto'`, which shrinks text to
 * fit — mangling every space into a line break turned "World Cup — Tournament
 * scene" into five lines on a 72px button.
 */
const buttonText = (name: string, verb: string) => `${name}\n${verb}`

export function BuildPresets(self: ModuleInstance, channels: ChannelRef[]): void {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const sections: CompanionPresetSection<ModuleSchema>[] = []

	for (const entry of channels) {
		const channel = entry.channel
		const label = entry.name || channel

		/*
		 * PLAY carries the on-air feedback and the missing-source warning.
		 *
		 * The warning is on PLAY rather than on its own button deliberately: it
		 * is the button someone is about to press, and it is the moment the
		 * information matters.
		 */
		presets[idFor(channel, 'play')] = {
			type: 'simple',
			name: `${entry.name} — PLAY`,
			style: { text: buttonText(label, 'PLAY'), size: 'auto', color: WHITE, bgcolor: GREEN },
			steps: [{ down: [{ actionId: 'play', options: { channel } }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'on_air',
					options: { channel },
					style: { bgcolor: RED, color: WHITE },
				},
				{
					feedbackId: 'source_connected',
					options: { channel },
					style: { bgcolor: AMBER, color: WHITE },
				},
			],
		}

		presets[idFor(channel, 'stop')] = {
			type: 'simple',
			name: `${entry.name} — STOP`,
			style: { text: buttonText(label, 'STOP'), size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'stop', options: { channel } }], up: [] }],
			feedbacks: [],
		}

		presets[idFor(channel, 'next')] = {
			type: 'simple',
			name: `${entry.name} — NEXT`,
			style: { text: buttonText(label, 'NEXT'), size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'next', options: { channel } }], up: [] }],
			feedbacks: [],
		}

		presets[idFor(channel, 'clear')] = {
			type: 'simple',
			name: `${entry.name} — CLEAR`,
			style: { text: buttonText(label, 'CLEAR'), size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'clear', options: { channel } }], up: [] }],
			feedbacks: [],
		}

		const ids = [
			idFor(channel, 'play'),
			idFor(channel, 'next'),
			idFor(channel, 'stop'),
			idFor(channel, 'clear'),
		]

		// CLEAR ALL only where it means something. On a plain scene it is the
		// same as CLEAR, and a button that duplicates its neighbour invites the
		// wrong one being pressed.
		const isScene = entry.sceneId === null
		if (isScene) {
			presets[idFor(channel, 'clear_all')] = {
				type: 'simple',
				name: `${entry.name} — CLEAR ALL`,
				style: { text: buttonText(label, 'CLR ALL'), size: 'auto', color: WHITE, bgcolor: combineRgb(120, 0, 0) },
				steps: [{ down: [{ actionId: 'clear_all', options: { channel } }], up: [] }],
				feedbacks: [],
			}
			ids.push(idFor(channel, 'clear_all'))
		}

		sections.push({
			id: `channel-${channel}`,
			name: entry.sceneId ? `${entry.name} (element of ${entry.sceneId})` : entry.name,
			description: `Channel ${channel}`,
			keywords: [channel, entry.name, entry.ref].filter(Boolean),
			definitions: ids,
		})
	}

	self.setPresetDefinitions(sections, presets)
}
