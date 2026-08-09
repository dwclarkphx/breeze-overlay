// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export type ModuleConfig = {
	host: string
	port: number
	project: string
	pollInterval: number
}

/**
 * The API key lives in `secrets`, not `config`.
 *
 * Companion treats secrets separately — they are not included when a
 * configuration is exported or shared, which is the whole point. A shared
 * server-wide key pasted into a config that then gets emailed around is exactly
 * the failure this avoids.
 */
export type ModuleSecrets = {
	apiKey: string
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'intro',
			width: 12,
			label: 'Breeze Overlay',
			value:
				'The address of the machine running the Breeze server — the one it prints at startup. ' +
				'Do not use localhost unless Companion is on that same machine.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Server address',
			width: 8,
			default: '127.0.0.1',
			// Not `Regex.IP`: a hostname is at least as common as an address on a
			// gallery LAN, and rejecting `graphics-pc` would be wrong.
			regex: Regex.SOMETHING,
		},
		{
			type: 'number',
			id: 'port',
			label: 'Port',
			width: 4,
			min: 1,
			max: 65535,
			default: 7331,
		},
		{
			type: 'textinput',
			id: 'project',
			label: 'Project URL key',
			width: 8,
			default: '',
		},
		{
			type: 'static-text',
			id: 'project-help',
			width: 4,
			label: '',
			value: 'Shown in the editor app bar, and on each tile on the portal.',
		},
		{
			type: 'secret-text',
			id: 'apiKey',
			label: 'API key (only if BREEZE_API_KEY is set)',
			width: 8,
			default: '',
		},
		{
			type: 'number',
			id: 'pollInterval',
			label: 'State poll (ms)',
			width: 4,
			min: 250,
			max: 10000,
			default: 1000,
		},
	]
}
