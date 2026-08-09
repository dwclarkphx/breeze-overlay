// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import type ModuleInstance from './main.js'

/**
 * Variables for the default channel only.
 *
 * Companion variable names are fixed at definition time, so a per-channel set
 * would mean redefining them every time a scene is added in Breeze — and a
 * variable that disappears breaks any button referencing it. The default
 * channel is the one a given connection is pointed at, which is the one worth
 * putting on a button; anything else is better served by a feedback, which
 * takes its channel as an option.
 */
export type VariablesSchema = {
	server_version: string
	project: string
	channel: string
	playback_state: string
	playback_step: string
	playback_steps: string
	sources_connected: string
	panels_connected: string
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({
		server_version: { name: 'Breeze server version' },
		project: { name: 'Default project key' },
		channel: { name: 'Default channel' },
		playback_state: { name: 'Playback state of the default channel' },
		playback_step: { name: 'Current step' },
		playback_steps: { name: 'Total steps' },
		sources_connected: { name: 'Browser sources attached to the default channel' },
		panels_connected: { name: 'Control panels and editors on the default channel' },
	})
}
