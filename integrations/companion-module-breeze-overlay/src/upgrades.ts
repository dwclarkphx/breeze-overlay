// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { ModuleConfig, ModuleSecrets } from './config.js'

/**
 * Config migrations, run once per connection when the module version changes.
 *
 * Empty at 0.1.0 — there is no older config to migrate from. Once an entry is
 * added here it can never be removed: a user upgrading from any older version
 * has to be able to replay the whole chain.
 */
export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets>[] = []
